import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  findOwnedAttachment,
  insertAttachment,
  insertUploadingAttachment,
  listAttachmentsForEntity,
  markAttachmentDeletePending,
  markAttachmentReady,
  renameAttachment,
  transferDraftAttachmentsToMessage,
  bumpDraftAttachmentRevision
} from './attachments';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly database: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async all<T>() { return { results: this.database.query(this.sql).all(...this.values) as T[] }; }
  async first<T>() { return (this.database.query(this.sql).get(...this.values) as T | null) ?? null; }
  async run() {
    this.database.query(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number((this.database.query('SELECT changes() AS changes').get() as { changes: number }).changes) } };
  }
}

const fixture = () => {
  const database = new Database(':memory:');
  database.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
  database.query(`INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone)
    VALUES ('owner-1', 'owner@example.test', 'Owner', 'Owner', 'owner@example.test', '', '', 'UTC')`).run();
  database.query(`INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone)
    VALUES ('owner-2', 'other@example.test', 'Other', 'Owner', 'other@example.test', '', '', 'UTC')`).run();
  database.query(`INSERT INTO workspace_drafts (id, user_id, to_email) VALUES ('draft-1', 'owner-1', 'to@example.test')`).run();
  database.query(`INSERT INTO workspace_messages (id, user_id, folder, from_name, from_email, to_name, to_email, sent_at)
    VALUES ('message-1', 'owner-1', 'sent', 'Owner', 'owner@example.test', 'To', 'to@example.test', '2026-08-19T00:00:00Z')`).run();
  database.query(`INSERT INTO email_messages (id, "from", "to", "timestamp", raw_key, owner_user_id)
    VALUES ('email-1', 'from@example.test', 'owner@example.test', '2026-08-19T00:00:00Z', 'raw/email-1', 'owner-1')`).run();
  const db = { prepare: (sql: string) => new Statement(database, sql) as unknown as D1PreparedStatement } as D1Database;
  return { database, db };
};

describe('outbound attachment repository', () => {
  test('keeps inbound compatibility and enforces owner-scoped draft lifecycle', async () => {
    const { database, db } = fixture();
    await insertAttachment(db, {
      id: 'inbound-1', userId: 'owner-1', messageId: 'email-1', filename: 'inbound.txt',
      contentType: 'text/plain', size: 4, inline: false, contentId: null, r2Key: 'inbound/email-1/inbound.txt'
    }).run();
    expect(await findOwnedAttachment(db, 'owner-1', 'email-1', 'inbound-1')).toMatchObject({ relation_type: 'inbound', state: 'ready' });
    expect(await findOwnedAttachment(db, 'owner-2', 'email-1', 'inbound-1')).toBeNull();

    await insertUploadingAttachment(db, {
      id: 'draft-attachment-1', userId: 'owner-1', draftId: 'draft-1', filename: 'draft.txt',
      contentType: 'text/plain', size: 4, r2Key: 'draft/owner-1/draft-1/draft-attachment-1'
    }).run();
    expect(database.query(`SELECT state, relation_type, sha256 FROM workspace_attachments WHERE id = 'draft-attachment-1'`).get())
      .toEqual({ state: 'uploading', relation_type: 'draft', sha256: null });

    expect((await markAttachmentReady(db, {
      userId: 'owner-1', entityId: 'draft-1', attachmentId: 'draft-attachment-1', sha256: 'a'.repeat(64), size: 4,
      r2Key: 'draft/owner-1/draft-1/draft-attachment-1', updatedAt: '2026-08-19T00:01:00Z', expectedRevision: 1
    }).run()).meta.changes).toBe(0);
    await bumpDraftAttachmentRevision(db, { userId: 'owner-1', draftId: 'draft-1', updatedAt: '2026-08-19T00:01:01Z' }).run();
    expect((await markAttachmentReady(db, {
      userId: 'owner-1', entityId: 'draft-1', attachmentId: 'draft-attachment-1', sha256: 'a'.repeat(64), size: 4,
      r2Key: 'draft/another-attempt', updatedAt: '2026-08-19T00:01:02Z', expectedRevision: 1
    }).run()).meta.changes).toBe(0);
    expect((await markAttachmentReady(db, {
      userId: 'owner-1', entityId: 'draft-1', attachmentId: 'draft-attachment-1', sha256: 'a'.repeat(64), size: 4,
      r2Key: 'draft/owner-1/draft-1/draft-attachment-1', updatedAt: '2026-08-19T00:01:02Z', expectedRevision: 1
    }).run()).meta.changes).toBe(1);
    expect((await renameAttachment(db, {
      userId: 'owner-1', entityId: 'draft-1', attachmentId: 'draft-attachment-1', filename: 'renamed.txt',
      updatedAt: '2026-08-19T00:01:03Z', expectedRevision: 0
    }).run()).meta.changes).toBe(0);
    expect(await listAttachmentsForEntity(db, 'owner-1', 'draft', 'draft-1')).toHaveLength(1);

    await markAttachmentDeletePending(db, {
      userId: 'owner-1', entityId: 'draft-1', attachmentId: 'draft-attachment-1', deleteAfter: '2026-08-20T00:00:00Z',
      updatedAt: '2026-08-19T00:01:04Z', expectedRevision: 1
    }).run();
    expect(await listAttachmentsForEntity(db, 'owner-1', 'draft', 'draft-1')).toHaveLength(0);
    expect(await listAttachmentsForEntity(db, 'owner-1', 'draft', 'draft-1', { includeNonReady: true })).toMatchObject([
      { state: 'delete_pending', filename: 'draft.txt' }
    ]);
  });

  test('transfers ready draft rows to a persisted sent message without exposing another owner', async () => {
    const { database, db } = fixture();
    await insertUploadingAttachment(db, {
      id: 'draft-attachment-2', userId: 'owner-1', draftId: 'draft-1', filename: 'send.txt',
      contentType: 'text/plain', size: 4, r2Key: 'draft/owner-1/draft-1/draft-attachment-2'
    }).run();
    await markAttachmentReady(db, {
      userId: 'owner-1', entityId: 'draft-1', attachmentId: 'draft-attachment-2', sha256: 'b'.repeat(64), size: 4,
      r2Key: 'draft/owner-1/draft-1/draft-attachment-2', updatedAt: '2026-08-19T00:02:00Z'
    }).run();
    expect((await transferDraftAttachmentsToMessage(db, {
      userId: 'owner-1', draftId: 'draft-1', messageId: 'message-1', updatedAt: '2026-08-19T00:02:01Z'
    }).run()).meta.changes).toBe(1);
    expect(database.query(`SELECT relation_type, message_id, state FROM workspace_attachments WHERE id = 'draft-attachment-2'`).get())
      .toEqual({ relation_type: 'message', message_id: 'message-1', state: 'ready' });
    expect(await listAttachmentsForEntity(db, 'owner-2', 'message', 'message-1')).toHaveLength(0);
  });
});
