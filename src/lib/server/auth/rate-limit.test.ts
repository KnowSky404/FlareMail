import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { cleanupLoginAttempts, clearLoginAttempts, consumeLoginAttempt, consumeMcpRegistration, isValidLoginUsername, normalizeLoginUsername } from './rate-limit';

class TestStatement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly database: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.database.query(this.sql).get(...this.values) as T | null) ?? null; }
  async run<T>() { this.database.query(this.sql).run(...this.values); return { success: true, results: [] as T[] }; }
}

const database = () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE workspace_login_rate_limits (
    identity_hash TEXT PRIMARY KEY,
    attempt_count INTEGER NOT NULL,
    window_started_at INTEGER NOT NULL,
    reset_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  return { sqlite, db: { prepare: (sql: string) => new TestStatement(sqlite, sql) } as unknown as D1Database };
};

describe('D1 login rate limiter', () => {
  test('blocks attempts beyond the durable bounded window', async () => {
    const { db, sqlite } = database();
    expect((await consumeLoginAttempt(db, 'IP:USER', 1_000, 2, 10_000)).allowed).toBe(true);
    expect((await consumeLoginAttempt(db, 'ip:user', 1_001, 2, 10_000)).allowed).toBe(true);
    expect(await consumeLoginAttempt(db, 'ip:user', 1_002, 2, 10_000)).toEqual({ allowed: false, retryAfterSeconds: 10 });
    expect(sqlite.query('SELECT attempt_count, updated_at FROM workspace_login_rate_limits').all())
      .toEqual([{ attempt_count: 2, updated_at: 1_001 }]);
    expect((await consumeLoginAttempt(db, 'ip:user', 11_000, 2, 10_000)).allowed).toBe(true);
    await cleanupLoginAttempts(db, 21_000);
    expect(sqlite.query('SELECT identity_hash FROM workspace_login_rate_limits').all()).toEqual([]);
  });

  test('sweeps expired counters after a successful write, keeping saturated reads read-only', async () => {
    const { db, sqlite } = database();
    const now = Date.now();
    const windowMs = 30 * 60 * 1000;
    await consumeLoginAttempt(db, 'saturated', now, 1, windowMs);
    sqlite.exec("INSERT INTO workspace_login_rate_limits VALUES ('expired', 1, 0, 1, 0)");
    const sweepTime = now + windowMs / 2;
    expect((await consumeLoginAttempt(db, 'saturated', sweepTime, 1, windowMs)).allowed).toBe(false);
    expect(sqlite.query("SELECT 1 FROM workspace_login_rate_limits WHERE identity_hash = 'expired'").get()).not.toBeNull();
    expect((await consumeLoginAttempt(db, 'different', sweepTime, 1, windowMs)).allowed).toBe(true);
    expect(sqlite.query("SELECT 1 FROM workspace_login_rate_limits WHERE identity_hash = 'expired'").get()).toBeNull();
  });

  test('caps public MCP registrations across requests without limiting token exchanges', async () => {
    const { db } = database();
    const now = Date.now();
    const attempts = await Promise.all(Array.from({ length: 101 }, () => consumeMcpRegistration(db, now)));
    expect(attempts.filter(({ allowed }) => allowed)).toHaveLength(100);
    expect(await consumeMcpRegistration(db, now)).toEqual({ allowed: false, retryAfterSeconds: 86_400 });
    const reserved = await Promise.all(Array.from({ length: 6 }, () => consumeMcpRegistration(db, now, 'owner')));
    expect(reserved.filter(({ allowed }) => allowed)).toHaveLength(5);
    expect((await consumeMcpRegistration(db, now)).allowed).toBe(false);
    expect(await consumeLoginAttempt(db, 'mcp:/mcp/token:192.0.2.1', now, 30, 60_000)).toMatchObject({ allowed: true });
    expect(await consumeMcpRegistration(db, now + 86_400_000)).toMatchObject({ allowed: true });
  });

  test('stores only a normalized identity hash and can clear a successful login', async () => {
    const { db, sqlite } = database();
    await consumeLoginAttempt(db, '198.51.100.1:Owner@Example.Test', 1_000, 1, 10_000);
    const row = sqlite.query('SELECT identity_hash FROM workspace_login_rate_limits').get() as { identity_hash: string };
    expect(row.identity_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.identity_hash).not.toContain('owner@example.test');
    await clearLoginAttempts(db, '198.51.100.1:owner@example.test');
    expect((await consumeLoginAttempt(db, '198.51.100.1:owner@example.test', 1_001, 1, 10_000)).allowed).toBe(true);
  });
});

describe('local login usernames', () => {
  test('normalizes without imposing email syntax', () => {
    expect(normalizeLoginUsername('  Ｆlower  ')).toBe('flower');
    expect(isValidLoginUsername('flower')).toBe(true);
    expect(isValidLoginUsername('owner.name+local')).toBe(true);
    expect(isValidLoginUsername('user@example.test')).toBe(true);
    expect(isValidLoginUsername('')).toBe(false);
    expect(isValidLoginUsername('-starts-with-punctuation')).toBe(false);
    expect(isValidLoginUsername('bad/name')).toBe(false);
    expect(isValidLoginUsername('x'.repeat(129))).toBe(false);
  });
});
