import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { FLAREMAIL_SCHEMA_VERSION } from '$lib/server/db/schema-version';
import { patchWorkspaceMessage } from './message';
import type { WorkspaceContext } from './shared';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly owner: CountingD1, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.owner.database.query(this.sql).get(...this.values) as T | null) ?? null; }
  async run() { this.owner.database.query(this.sql).run(...this.values); return { success: true, meta: { changes: Number((this.owner.database.query('SELECT changes() AS changes').get() as { changes: number }).changes) } }; }
}

class CountingD1 {
  queryCount = 0;
  constructor(readonly database: Database) {}
  prepare(sql: string) { this.queryCount += 1; return new Statement(this, sql) as unknown as D1PreparedStatement; }
  async batch(statements: D1PreparedStatement[]) { return Promise.all(statements.map((statement) => statement.run())); }
}

function fixture(messageCount: number) {
  const database = new Database(':memory:');
  database.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
  database.query(`INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence)
    VALUES ('user-1', 'owner@example.test', 'Owner', 'Owner', 'owner@example.test', '', '', 'UTC', 0, '', 0)`).run();
  database.query(`INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
    VALUES ('flaremail', ?, '2026-09-14T00:00:00.000Z')`).run(FLAREMAIL_SCHEMA_VERSION);
  for (let index = 0; index < messageCount; index += 1) {
    database.query(`INSERT INTO workspace_messages (id, user_id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at)
      VALUES (?, 'user-1', 'inbox', 'Alice', 'alice@example.test', 'Owner', 'owner@example.test', 'Subject', 'Preview', 'Body', ?)`)
      .run(`message-${index}`, new Date(1_700_000_000_000 + index).toISOString());
  }
  const DB = new CountingD1(database);
  const session: WorkspaceContext = { id: 'session-1', userId: 'user-1', profile: {
    name: 'Owner', role: 'Owner', email: 'owner@example.test', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: ''
  }, incomingSequence: 0, createdAt: '', updatedAt: '', storage: 'd1' };
  return { DB, session, env: { DB } as never };
}

describe('mutation query budget', () => {
  test('uses the same statement count and returns a delta for small and large mailboxes', async () => {
    const small = fixture(10);
    const large = fixture(500);
    const smallResult = await patchWorkspaceMessage(small.env, small.session, 'message-0', { starred: true });
    const largeResult = await patchWorkspaceMessage(large.env, large.session, 'message-0', { starred: true });
    expect(small.DB.queryCount).toBe(large.DB.queryCount);
    expect(Object.keys(smallResult ?? {})).toEqual(['message', 'metrics', 'metricsScope']);
    expect(Object.keys(largeResult ?? {})).toEqual(['message', 'metrics', 'metricsScope']);
    expect(JSON.stringify(smallResult)).not.toContain('message-1');
  });

  test('updates an owned draft star through the existing message flags contract', async () => {
    const value = fixture(0);
    value.DB.database.query(`INSERT INTO workspace_drafts (id, user_id, to_email, subject, body, is_starred, updated_at)
      VALUES ('draft-1', 'user-1', 'reader@example.test', 'Draft subject', 'Draft body', 0, '2026-09-14T00:00:00.000Z')`).run();

    const result = await patchWorkspaceMessage(value.env, value.session, 'draft-1', { starred: true });

    expect(result?.message).toMatchObject({ id: 'draft-1', folder: 'drafts', starred: true });
    expect((value.DB.database.query(`SELECT is_starred FROM workspace_drafts WHERE id = 'draft-1'`).get() as { is_starred: number }).is_starred).toBe(1);
  });
});
