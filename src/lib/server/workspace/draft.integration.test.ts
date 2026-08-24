import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { DraftBodyReloadRequiredError, DraftConflictError, DraftNotFoundError, saveWorkspaceDraft } from './draft';
import type { WorkspaceContext } from './shared';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly db: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.db.query(this.sql).get(...this.values) as T | null) ?? null; }
  async all<T>() { return { success: true, results: this.db.query(this.sql).all(...this.values) as T[] }; }
  async run() { this.db.query(this.sql).run(...this.values); return { success: true, meta: { changes: Number((this.db.query('SELECT changes() AS changes').get() as { changes: number }).changes) } }; }
}

class D1 {
  constructor(readonly database: Database) {}
  prepare(sql: string) { return new Statement(this.database, sql) as unknown as D1PreparedStatement; }
  async batch(statements: D1PreparedStatement[]) { return Promise.all(statements.map((statement) => statement.run())); }
}

class Bucket {
  readonly objects = new Set<string>();
  async put(key: string) { this.objects.add(key); }
  async delete(key: string) { this.objects.delete(key); }
}

const fixture = () => {
  const database = new Database(':memory:');
  database.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
  database.query(`INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence)
    VALUES ('user-1', 'owner@example.test', 'Owner', 'Owner', 'owner@example.test', '', '', 'UTC', 0, '', 0)`).run();
  const DB = new D1(database);
  const session: WorkspaceContext = { id: 'session-1', userId: 'user-1', profile: {
    name: 'Owner', role: 'Owner', email: 'owner@example.test', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: ''
  }, incomingSequence: 0, createdAt: '', updatedAt: '', storage: 'd1' };
  const bucket = new Bucket();
  return { database, DB, bucket, env: { DB, BUCKET: bucket } as never, session };
};

const input = (extra: Record<string, unknown> = {}) => ({ toEmail: 'alice@example.net', cc: '', subject: 'Subject', body: 'Body', ...extra });

describe('draft optimistic concurrency', () => {
  test('separates create, versioned update, conflict, overwrite and save-as-copy', async () => {
    const { DB, env, session, database } = fixture();
    const created = await saveWorkspaceDraft(env, session, input());
    const current = created.message;
    const updated = await saveWorkspaceDraft(env, session, input({ draftId: current.id, expectedUpdatedAt: current.sentAt, body: 'Server version' }));
    const consecutive = await saveWorkspaceDraft(env, session, input({ draftId: current.id, expectedUpdatedAt: updated.message.sentAt, body: 'Consecutive version' }));
    expect(consecutive.message.sentAt > updated.message.sentAt).toBe(true);
    expect(consecutive.message.body).toBe('Consecutive version');
    await expect(saveWorkspaceDraft(env, session, input({ draftId: current.id, expectedUpdatedAt: '2000-01-01T00:00:00.000Z', body: 'Stale local version' })))
      .rejects.toBeInstanceOf(DraftConflictError);
    const overwritten = await saveWorkspaceDraft(env, session, input({ draftId: current.id, expectedUpdatedAt: consecutive.message.sentAt, body: 'Explicit overwrite', overwrite: true }));
    expect(overwritten.message.body).toBe('Explicit overwrite');
    const copy = await saveWorkspaceDraft(env, session, input({ draftId: current.id, saveAsCopy: true, body: 'Copy' }));
    expect(copy.message.id).not.toBe(current.id);
    expect((database.query('SELECT body FROM workspace_drafts WHERE id = ?').get(current.id) as { body: string }).body).toBe('Explicit overwrite');
    database.query('DELETE FROM workspace_drafts WHERE id = ?').run(consecutive.message.id);
    await expect(saveWorkspaceDraft(env, session, input({ draftId: consecutive.message.id, expectedUpdatedAt: consecutive.message.sentAt })))
      .rejects.toBeInstanceOf(DraftNotFoundError);
    void DB;
  });

  test('does not mutate body metadata or R2 on a large draft CAS conflict', async () => {
    const { DB, env, session, database, bucket } = fixture();
    const large = '正文😀'.repeat(90_000);
    const created = await saveWorkspaceDraft(env, session, input({ body: large }));
    const before = database.query('SELECT body_object_id FROM workspace_drafts WHERE id = ?').get(created.message.id) as { body_object_id: string | null };
    expect(before.body_object_id).toBeString();
    expect(bucket.objects.size).toBe(1);
    const objectCount = Number((database.query('SELECT COUNT(*) AS count FROM mail_body_objects').get() as { count: number }).count);
    await expect(saveWorkspaceDraft(env, session, input({ draftId: created.message.id, expectedUpdatedAt: '2000-01-01T00:00:00.000Z', bodyRevision: created.bodyRevision, body: `${large}changed` })))
      .rejects.toBeInstanceOf(DraftConflictError);
    expect(Number((database.query('SELECT COUNT(*) AS count FROM mail_body_objects').get() as { count: number }).count)).toBe(objectCount);
    expect(database.query('SELECT state FROM mail_body_objects').get()).toEqual({ state: 'active' });
    expect(bucket.objects.size).toBe(1);
    void DB;
  });

  test('preserves a canonical pointer for an unchanged legacy projection and rejects projection edits', async () => {
    const { DB, env, session, database, bucket } = fixture();
    const large = 'tail-safe😀'.repeat(40_000);
    const created = await saveWorkspaceDraft(env, session, input({ body: large }));
    const row = database.query('SELECT body, body_object_id, updated_at FROM workspace_drafts WHERE id = ?').get(created.message.id) as {
      body: string; body_object_id: string; updated_at: string;
    };
    const metadataOnly = await saveWorkspaceDraft(env, session, input({
      draftId: created.message.id,
      expectedUpdatedAt: row.updated_at,
      subject: 'Metadata changed',
      body: row.body
    }));
    expect(metadataOnly.bodyRevision).toBe(row.body_object_id);
    expect(bucket.objects.size).toBe(1);
    expect((database.query('SELECT body_object_id FROM workspace_drafts WHERE id = ?').get(created.message.id) as { body_object_id: string }).body_object_id)
      .toBe(row.body_object_id);
    await expect(saveWorkspaceDraft(env, session, input({
      draftId: created.message.id,
      expectedUpdatedAt: metadataOnly.message.sentAt,
      body: `${row.body}unsafe edit`
    }))).rejects.toBeInstanceOf(DraftBodyReloadRequiredError);
    void DB;
  });
});
