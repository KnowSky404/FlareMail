import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GET } from './+server';
import type { WorkspaceContext } from '$lib/server/workspace/shared';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly db: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.db.query(this.sql).get(...this.values) as T | null) ?? null; }
  async all<T>() { return { results: this.db.query(this.sql).all(...this.values) as T[] }; }
  async run() { const result = this.db.query(this.sql).run(...this.values); return { meta: { changes: Number(result.changes) } }; }
}

class D1 {
  constructor(readonly db: Database) {}
  prepare(sql: string) { return new Statement(this.db, sql) as unknown as D1PreparedStatement; }
  async batch(statements: D1PreparedStatement[]) {
    return this.db.transaction(() => statements.map((statement) => (statement as unknown as Statement).run()))();
  }
}

const session = (userId: string): WorkspaceContext => ({
  id: 'session',
  userId,
  storage: 'd1',
  incomingSequence: 0,
  createdAt: '',
  updatedAt: '',
  profile: {
    name: 'Owner', role: 'Owner', email: 'owner@example.test', company: '', location: '', timezone: 'UTC',
    forwardingEnabled: false, signature: ''
  }
});

const databases: Database[] = [];

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(readFileSync(new URL('../../../../../../schema.sql', import.meta.url), 'utf8'));
  db.query(`INSERT INTO workspace_users
    (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence)
    VALUES ('user-1', 'owner@example.test', 'Owner', 'Owner', 'owner@example.test', '', '', 'UTC', 0, '', 0),
      ('user-2', 'other@example.test', 'Other', 'Member', 'other@example.test', '', '', 'UTC', 0, '', 0)`).run();
  db.query(`INSERT INTO email_messages
    (id, message_id, "from", "to", subject, "timestamp", snippet, raw_key, dedupe_key, owner_user_id)
    VALUES ('email-deep', '<deep@example.test>', 'Sender <sender@example.test>', 'owner@example.test',
      'Deep target', '2026-09-09T12:00:00.000Z', 'Target preview', 'raw/email-deep', 'dedupe-deep', 'user-1')`).run();
  return { db, env: { DB: new D1(db) } };
}

function event(env: { DB: D1 }, userId: string, id: string) {
  return {
    request: new Request(`https://flaremail.test/api/workspace/messages/${encodeURIComponent(id)}`),
    url: new URL(`https://flaremail.test/api/workspace/messages/${encodeURIComponent(id)}`),
    params: { id },
    locals: { workspaceSession: session(userId) },
    platform: { env }
  } as never;
}

afterEach(() => { while (databases.length) databases.pop()?.close(); });

describe('workspace message metadata API', () => {
  test('returns owner-scoped metadata without loading the canonical body', async () => {
    const value = fixture();
    const response = await GET(event(value.env, 'user-1', 'email:email-deep'));
    expect(response.status).toBe(200);
    const payload = await response.json() as { data: { message: { id: string; subject: string; body: string }; metrics: { inboxCount: number } } };
    expect(payload.data.message).toMatchObject({ id: 'email:email-deep', subject: 'Deep target', body: '' });
    expect(payload.data.metrics.inboxCount).toBe(1);
  });

  test('does not reveal another owner or a deleted inbound message', async () => {
    const value = fixture();
    expect((await GET(event(value.env, 'user-2', 'email:email-deep'))).status).toBe(404);
    value.db.query(`INSERT INTO workspace_email_states
      (id, user_id, email_message_id, deleted_at) VALUES ('state-deleted', 'user-1', 'email-deep', '2026-09-09T12:01:00.000Z')`).run();
    expect((await GET(event(value.env, 'user-1', 'email:email-deep'))).status).toBe(404);
  });
});
