import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { emptyWorkspaceTrash, listWorkspaceTrash, moveWorkspaceMessageToTrash, permanentlyDeleteWorkspaceTrash, restoreWorkspaceTrash } from './trash';
import type { WorkspaceContext } from './shared';

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
  async batch(statements: D1PreparedStatement[]) { this.db.exec('BEGIN'); try { for (const statement of statements) await (statement as unknown as Statement).run(); this.db.exec('COMMIT'); return []; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
}
class Bucket {
  readonly objects = new Set<string>();
  async delete(key: string) { this.objects.delete(key); }
}

const databases: Database[] = [];
const session: WorkspaceContext = {
  id: 'session-1', userId: 'owner-1', storage: 'd1', incomingSequence: 0, createdAt: '', updatedAt: '',
  profile: { name: 'Owner', role: 'Owner', email: 'owner@example.test', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' }
};

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(readFileSync(resolve(import.meta.dir, '../../../../schema.sql'), 'utf8'));
  db.query(`INSERT INTO workspace_messages (id, user_id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at) VALUES ('sent-1', 'owner-1', 'sent', 'Owner', 'owner@example.test', 'Bob', 'bob@example.test', 'Subject', 'Preview', 'Body', '2026-08-19T00:00:00Z')`).run();
  db.query(`INSERT INTO workspace_messages (id, user_id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at) VALUES ('other-1', 'other', 'sent', 'Other', 'other@example.test', 'Bob', 'bob@example.test', 'Other', 'Preview', 'Body', '2026-08-19T00:00:00Z')`).run();
  db.query(`INSERT INTO workspace_drafts (id, user_id, to_email, subject, body, updated_at) VALUES ('draft-1', 'owner-1', 'bob@example.test', 'Draft', 'Body', '2026-08-19T00:00:00Z')`).run();
  db.query(`INSERT INTO email_messages (id, owner_user_id, "from", "to", subject, "timestamp", snippet, raw_key, text_body, direction) VALUES ('in-1', 'owner-1', 'bob@example.test', 'owner@example.test', 'Inbound', '2026-08-19T00:00:00Z', 'Snippet', 'inbound/in-1/message.eml', 'Body', 'inbound')`).run();
  db.query(`INSERT INTO workspace_attachments (id, user_id, message_id, filename, r2_key) VALUES ('att-1', 'owner-1', 'sent-1', 'a.txt', 'sent/att-1')`).run();
  db.query(`INSERT INTO workspace_outbound_statuses (message_id, user_id, status) VALUES ('sent-1', 'owner-1', 'sent')`).run();
  db.query(`INSERT INTO mail_body_objects (id, owner_user_id, entity_type, entity_id, r2_key, size_bytes, sha256, created_at, updated_at) VALUES ('body-1', 'owner-1', 'workspace_message', 'sent-1', 'body/sent-1', 1, 'hash', '2026-08-19T00:00:00Z', '2026-08-19T00:00:00Z')`).run();
  return { db, DB: new D1(db), bucket: new Bucket() };
}

afterEach(() => { while (databases.length) databases.pop()?.close(); });

describe('workspace trash', () => {
  test('moves workspace, draft and inbound rows without exposing them in the mailbox', async () => {
    const { db, DB, bucket } = fixture();
    const env = { DB, BUCKET: bucket } as never;
    await moveWorkspaceMessageToTrash(env, session, 'sent-1');
    await moveWorkspaceMessageToTrash(env, session, 'draft-1');
    await moveWorkspaceMessageToTrash(env, session, 'email:in-1');
    expect(db.query(`SELECT deleted_at FROM workspace_messages WHERE id = 'sent-1'`).get()).not.toEqual({ deleted_at: null });
    expect((await listWorkspaceTrash(env, session)).items.map((item) => item.id).sort()).toEqual(['draft-1', 'email:in-1', 'sent-1']);
    expect((await restoreWorkspaceTrash(env, session, 'email:in-1'))?.restoredId).toBe('email:in-1');
    expect((await restoreWorkspaceTrash(env, session, 'email:in-1'))?.idempotent).toBe(true);
    expect((await moveWorkspaceMessageToTrash(env, session, 'sent-1'))?.idempotent).toBe(true);
  });

  test('prevents cross-owner mutation and permanently cleans D1 and R2 resources idempotently', async () => {
    const { db, DB, bucket } = fixture();
    bucket.objects.add('inbound/in-1/message.eml'); bucket.objects.add('sent/att-1'); bucket.objects.add('body/sent-1');
    const env = { DB, BUCKET: bucket } as never;
    expect(await moveWorkspaceMessageToTrash(env, session, 'other-1')).toBeNull();
    await moveWorkspaceMessageToTrash(env, session, 'sent-1');
    expect((await permanentlyDeleteWorkspaceTrash(env, session, 'sent-1')).idempotent).toBe(false);
    expect((await permanentlyDeleteWorkspaceTrash(env, session, 'sent-1')).idempotent).toBe(true);
    expect(db.query(`SELECT COUNT(*) AS count FROM workspace_attachments WHERE message_id = 'sent-1'`).get()).toEqual({ count: 0 });
    expect(db.query(`SELECT COUNT(*) AS count FROM mail_body_objects WHERE entity_id = 'sent-1'`).get()).toEqual({ count: 0 });
    expect(db.query(`SELECT COUNT(*) AS count FROM workspace_outbound_statuses WHERE message_id = 'sent-1'`).get()).toEqual({ count: 0 });
    expect(bucket.objects.size).toBe(1);
  });

  test('empty trash is bounded and reports deleted count', async () => {
    const { DB, bucket } = fixture();
    const env = { DB, BUCKET: bucket } as never;
    await moveWorkspaceMessageToTrash(env, session, 'sent-1');
    await moveWorkspaceMessageToTrash(env, session, 'draft-1');
    const result = await emptyWorkspaceTrash(env, session);
    expect(result.deleted).toBe(2);
    expect(result.metrics.trashCount).toBe(0);
  });
});
