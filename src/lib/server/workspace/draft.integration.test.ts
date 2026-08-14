import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { DraftConflictError, DraftNotFoundError, saveWorkspaceDraft } from './draft';
import type { WorkspaceContext } from './shared';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly db: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.db.query(this.sql).get(...this.values) as T | null) ?? null; }
  async run() { this.db.query(this.sql).run(...this.values); return { success: true, meta: { changes: Number((this.db.query('SELECT changes() AS changes').get() as { changes: number }).changes) } }; }
}

class D1 {
  constructor(readonly database: Database) {}
  prepare(sql: string) { return new Statement(this.database, sql) as unknown as D1PreparedStatement; }
  async batch(statements: D1PreparedStatement[]) { return Promise.all(statements.map((statement) => statement.run())); }
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
  return { database, DB, env: { DB } as never, session };
};

const input = (extra: Record<string, unknown> = {}) => ({ toEmail: 'alice@example.net', cc: '', subject: 'Subject', body: 'Body', ...extra });

describe('draft optimistic concurrency', () => {
  test('separates create, versioned update, conflict, overwrite and save-as-copy', async () => {
    const { DB, env, session, database } = fixture();
    const created = await saveWorkspaceDraft(env, session, input());
    const current = created.message;
    const updated = await saveWorkspaceDraft(env, session, input({ draftId: current.id, expectedUpdatedAt: current.sentAt, body: 'Server version' }));
    await expect(saveWorkspaceDraft(env, session, input({ draftId: current.id, expectedUpdatedAt: '2000-01-01T00:00:00.000Z', body: 'Stale local version' })))
      .rejects.toBeInstanceOf(DraftConflictError);
    const overwritten = await saveWorkspaceDraft(env, session, input({ draftId: current.id, expectedUpdatedAt: updated.message.sentAt, body: 'Explicit overwrite', overwrite: true }));
    expect(overwritten.message.body).toBe('Explicit overwrite');
    const copy = await saveWorkspaceDraft(env, session, input({ draftId: current.id, saveAsCopy: true, body: 'Copy' }));
    expect(copy.message.id).not.toBe(current.id);
    database.query('DELETE FROM workspace_drafts WHERE id = ?').run(updated.message.id);
    await expect(saveWorkspaceDraft(env, session, input({ draftId: updated.message.id, expectedUpdatedAt: updated.message.sentAt })))
      .rejects.toBeInstanceOf(DraftNotFoundError);
    void DB;
  });
});
