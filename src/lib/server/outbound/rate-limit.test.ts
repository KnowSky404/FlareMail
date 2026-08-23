import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  consumeOutboundRateLimit,
  DEFAULT_OUTBOUND_SEND_LIMIT,
  DEFAULT_OUTBOUND_SEND_WINDOW_MS
} from './rate-limit';

class TestStatement {
  private values: SQLQueryBindings[] = [];

  constructor(private readonly database: Database, private readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values as SQLQueryBindings[];
    return this as unknown as D1PreparedStatement;
  }

  async first<T>() {
    return (this.database.query(this.sql).get(...this.values) as T | null) ?? null;
  }

  async run<T>() {
    this.database.query(this.sql).run(...this.values);
    return { success: true, results: [] as T[] };
  }
}

function setup() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE workspace_outbound_rate_limits (
      user_id TEXT PRIMARY KEY,
      attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
      window_started_at INTEGER NOT NULL,
      reset_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_workspace_outbound_rate_limits_reset_at
      ON workspace_outbound_rate_limits(reset_at);
  `);
  const db = {
    prepare: (sql: string) => new TestStatement(sqlite, sql)
  } as unknown as D1Database;
  return { db, sqlite };
}

describe('D1 outbound send rate limiter', () => {
  test('allows the default quota and returns the remaining window after the limit', async () => {
    const { db, sqlite } = setup();
    const now = 1_000;

    for (let attempt = 0; attempt < DEFAULT_OUTBOUND_SEND_LIMIT; attempt += 1) {
      await expect(consumeOutboundRateLimit(db, 'user-1', now + attempt)).resolves.toEqual({
        allowed: true,
        retryAfterSeconds: 0
      });
    }
    await expect(consumeOutboundRateLimit(db, 'user-1', now + DEFAULT_OUTBOUND_SEND_LIMIT)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: Math.ceil((DEFAULT_OUTBOUND_SEND_WINDOW_MS - DEFAULT_OUTBOUND_SEND_LIMIT) / 1000)
    });
    expect(sqlite.query('SELECT user_id, attempt_count, window_started_at, reset_at FROM workspace_outbound_rate_limits').all())
      .toEqual([{ user_id: 'user-1', attempt_count: DEFAULT_OUTBOUND_SEND_LIMIT + 1, window_started_at: now, reset_at: now + DEFAULT_OUTBOUND_SEND_WINDOW_MS }]);
  });

  test('keeps users independent, resets an expired window, and cleans old rows', async () => {
    const { db, sqlite } = setup();
    await expect(consumeOutboundRateLimit(db, 'user-1', 1_000, 1, 10_000)).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    await expect(consumeOutboundRateLimit(db, 'user-2', 1_001, 1, 10_000)).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    await expect(consumeOutboundRateLimit(db, 'user-1', 1_002, 1, 10_000)).resolves.toEqual({ allowed: false, retryAfterSeconds: 10 });

    await expect(consumeOutboundRateLimit(db, 'user-1', 11_000, 1, 10_000)).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(sqlite.query('SELECT user_id, attempt_count, window_started_at, reset_at FROM workspace_outbound_rate_limits ORDER BY user_id').all())
      .toEqual([
        { user_id: 'user-1', attempt_count: 1, window_started_at: 11_000, reset_at: 21_000 },
        { user_id: 'user-2', attempt_count: 1, window_started_at: 1_001, reset_at: 11_001 }
      ]);

    await consumeOutboundRateLimit(db, 'user-2', 21_001, 1, 10_000);
    expect(sqlite.query('SELECT user_id FROM workspace_outbound_rate_limits ORDER BY user_id').all())
      .toEqual([{ user_id: 'user-2' }]);
  });

  test('persists no recipient or message fields', async () => {
    const { db, sqlite } = setup();
    await consumeOutboundRateLimit(db, 'user-1', 1_000);
    const columns = (sqlite.query('PRAGMA table_info(workspace_outbound_rate_limits)').all() as Array<{ name: string }>)
      .map(({ name }) => name);
    expect(columns).toEqual(['user_id', 'attempt_count', 'window_started_at', 'reset_at', 'updated_at']);
    expect(columns).not.toContain('to');
    expect(columns).not.toContain('recipient');
    expect(columns).not.toContain('subject');
    expect(columns).not.toContain('body');
  });
});
