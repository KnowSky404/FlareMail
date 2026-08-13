import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { clearLoginAttempts, consumeLoginAttempt } from './rate-limit';

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
    expect(sqlite.query('SELECT COUNT(*) AS count FROM workspace_login_rate_limits').get()).toEqual({ count: 1 });
    expect((await consumeLoginAttempt(db, 'ip:user', 11_000, 2, 10_000)).allowed).toBe(true);
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
