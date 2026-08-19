import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { assertDraftAttachmentRevision, deleteDraft } from '$lib/server/db/drafts';
import { assertDraftAttachmentSet, insertUploadingAttachment } from '$lib/server/db/attachments';
import { DraftAttachmentError, draftAttachmentSnapshot, removeDraftAttachment, updateDraftAttachmentName, uploadDraftAttachment } from './attachment';
import type { WorkspaceContext } from './shared';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly database: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.database.query(this.sql).get(...this.values) as T | null) ?? null; }
  async all<T>() { return { success: true, results: this.database.query(this.sql).all(...this.values) as T[] }; }
  async run<T>() {
    this.database.query(this.sql).run(...this.values);
    const changes = Number((this.database.query('SELECT changes() AS changes').get() as { changes: number }).changes);
    return { success: true, results: [] as T[], meta: { changes } };
  }
}

class TestD1 {
  constructor(readonly database: Database) {}
  prepare(sql: string) { return new Statement(this.database, sql) as unknown as D1PreparedStatement; }
  async batch(statements: D1PreparedStatement[]) {
    this.database.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

class TestBucket {
  readonly objects = new Map<string, Uint8Array>();
  streamed = false;
  failDelete = false;
  async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null, options?: R2PutOptions) {
    this.streamed = value instanceof ReadableStream;
    const bytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (typeof options?.sha256 === 'string' && digest !== options.sha256) throw new Error('checksum mismatch');
    this.objects.set(key, bytes);
    return { key, size: bytes.byteLength } as R2Object;
  }
  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      key,
      size: bytes.byteLength,
      body: new Blob([ownedBuffer(bytes)]).stream(),
      arrayBuffer: async () => ownedBuffer(bytes)
    } as unknown as R2ObjectBody;
  }
  async delete(key: string) {
    if (this.failDelete) throw new Error('delete unavailable');
    this.objects.delete(key);
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
  const bucket = new TestBucket();
  const env = { DB: new TestD1(database), BUCKET: bucket } as unknown as import('$lib/server/cloudflare').CloudflareEnv;
  const session = (userId = 'owner-1'): WorkspaceContext => ({
    id: `session-${userId}`, userId, profile: { name: 'Owner', role: 'Owner', email: `${userId}@example.test`, company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' },
    incomingSequence: 0, createdAt: '', updatedAt: '', storage: 'd1'
  });
  return { database, bucket, env, session };
};

const bytes = new TextEncoder().encode('attachment payload');
const ownedBuffer = (value: Uint8Array) => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
const checksum = async (value: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', ownedBuffer(value)))]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');

describe('draft attachment lifecycle', () => {
  test('streams to an opaque R2 key and advances optimistic revisions through rename and delete', async () => {
    const { database, bucket, env, session } = fixture();
    const attachmentId = '019d1234-5678-4abc-8def-0123456789ab';
    const uploaded = await uploadDraftAttachment(env, session(), {
      draftId: 'draft-1', attachmentId, filename: '../quarterly report.txt', contentType: 'text/plain',
      size: bytes.byteLength, sha256: await checksum(bytes), attachmentRevision: 0,
      body: new Blob([ownedBuffer(bytes)]).stream()
    });
    expect(bucket.streamed).toBe(true);
    expect(uploaded).toMatchObject({ attachmentRevision: 1, attachments: [{ id: attachmentId, filename: 'quarterly report.txt', state: 'ready' }] });
    const row = database.query(`SELECT r2_key, state, sha256 FROM workspace_attachments WHERE id = ?`).get(attachmentId) as { r2_key: string; state: string; sha256: string };
    expect(row.r2_key).toMatch(/^outbound\/v1\/\d{4}-\d{2}-\d{2}\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.bin$/);
    expect(row.r2_key).not.toContain('quarterly');
    expect(bucket.objects.has(row.r2_key)).toBe(true);

    await expect(updateDraftAttachmentName(env, session(), {
      draftId: 'draft-1', attachmentId, filename: 'stale.txt', attachmentRevision: 0
    })).rejects.toBeInstanceOf(DraftAttachmentError);
    const renamed = await updateDraftAttachmentName(env, session(), {
      draftId: 'draft-1', attachmentId, filename: 'final.txt', attachmentRevision: 1
    });
    expect(renamed).toMatchObject({ attachmentRevision: 2, attachments: [{ filename: 'final.txt' }] });
    await expect(removeDraftAttachment(env, session('owner-2'), {
      draftId: 'draft-1', attachmentId, attachmentRevision: 2
    })).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    const removed = await removeDraftAttachment(env, session(), {
      draftId: 'draft-1', attachmentId, attachmentRevision: 2
    });
    expect(removed).toMatchObject({ attachmentRevision: 3, attachments: [] });
    expect(bucket.objects.size).toBe(0);
  });

  test('restores failed uploads in the draft snapshot and preserves cleanup references', async () => {
    const { database, bucket, env, session } = fixture();
    await expect(uploadDraftAttachment(env, session(), {
      draftId: 'draft-1', attachmentId: '019d1234-5678-4abc-8def-1123456789ab', filename: 'bad.txt',
      contentType: 'text/plain', size: bytes.byteLength, sha256: '0'.repeat(64), attachmentRevision: 0,
      body: new Blob([ownedBuffer(bytes)]).stream()
    })).rejects.toMatchObject({ code: 'ATTACHMENT_UPLOAD_FAILED' });
    expect(database.query(`SELECT state, delete_after FROM workspace_attachments`).get()).toMatchObject({ state: 'failed' });
    expect(bucket.objects.size).toBe(0);
    expect(database.query(`SELECT attachment_revision FROM workspace_drafts WHERE id = 'draft-1'`).get()).toEqual({ attachment_revision: 0 });
    expect(await draftAttachmentSnapshot(env.DB, 'owner-1', 'draft-1')).toMatchObject({
      attachmentRevision: 0,
      attachments: [{ state: 'failed', filename: 'bad.txt' }]
    });

    bucket.failDelete = true;
    await expect(uploadDraftAttachment(env, session(), {
      draftId: 'draft-1', attachmentId: '019d1234-5678-4abc-8def-1123456789ab', filename: 'bad.txt',
      contentType: 'text/plain', size: bytes.byteLength, sha256: await checksum(bytes), attachmentRevision: 0,
      body: new Blob([ownedBuffer(bytes)]).stream()
    })).rejects.toMatchObject({ code: 'ATTACHMENT_STORAGE_UNAVAILABLE' });
    expect(database.query(`SELECT state FROM workspace_attachments`).get()).toEqual({ state: 'failed' });

    bucket.failDelete = false;
    const retried = await uploadDraftAttachment(env, session(), {
      draftId: 'draft-1', attachmentId: '019d1234-5678-4abc-8def-1123456789ab', filename: 'retry.txt',
      contentType: 'text/plain', size: bytes.byteLength, sha256: await checksum(bytes), attachmentRevision: 0,
      body: new Blob([ownedBuffer(bytes)]).stream()
    });
    expect(retried).toMatchObject({
      attachmentRevision: 1,
      attachments: [{ state: 'ready', filename: 'retry.txt' }]
    });
    expect(database.query(`SELECT COUNT(*) AS count FROM workspace_attachments`).get()).toEqual({ count: 1 });
  });

  test('aborts a streaming upload as soon as it exceeds the declared byte count', async () => {
    const { database, bucket, env, session } = fixture();
    await expect(uploadDraftAttachment(env, session(), {
      draftId: 'draft-1',
      attachmentId: '019d1234-5678-4abc-8def-5123456789ab',
      filename: 'oversized.txt',
      contentType: 'text/plain',
      size: bytes.byteLength - 1,
      sha256: await checksum(bytes),
      attachmentRevision: 0,
      body: new Blob([ownedBuffer(bytes)]).stream()
    })).rejects.toMatchObject({ code: 'ATTACHMENT_UPLOAD_FAILED' });
    expect(bucket.objects.size).toBe(0);
    expect(database.query(`SELECT state FROM workspace_attachments`).get()).toEqual({ state: 'failed' });
  });

  test('reserves cancelled IDs so a late upload cannot resurrect an attachment', async () => {
    const { database, env, session } = fixture();
    const attachmentId = '019d1234-5678-4abc-8def-2123456789ab';
    const cancelled = await removeDraftAttachment(env, session(), {
      draftId: 'draft-1', attachmentId, attachmentRevision: 0
    });
    expect(cancelled).toMatchObject({ attachmentRevision: 1, attachments: [] });
    expect(database.query(`SELECT state, delete_after FROM workspace_attachments WHERE id = ?`).get(attachmentId))
      .toMatchObject({ state: 'delete_pending' });
    await expect(uploadDraftAttachment(env, session(), {
      draftId: 'draft-1', attachmentId, filename: 'late.txt', contentType: 'text/plain',
      size: bytes.byteLength, sha256: await checksum(bytes), attachmentRevision: 0,
      body: new Blob([ownedBuffer(bytes)]).stream()
    })).rejects.toMatchObject({ code: 'ATTACHMENT_CONFLICT' });
    expect(database.query(`SELECT state FROM workspace_attachments WHERE id = ?`).get(attachmentId))
      .toEqual({ state: 'delete_pending' });
  });

  test('fails the first stale revision guard without deleting the draft or polluting schema metadata', async () => {
    const { database, env } = fixture();
    const guard = assertDraftAttachmentRevision(env.DB, 'owner-1', 'draft-1', 0);
    const deletion = deleteDraft(env.DB, 'owner-1', 'draft-1');
    database.query(`UPDATE workspace_drafts SET attachment_revision = 1 WHERE id = 'draft-1'`).run();
    await expect(env.DB.batch([guard, deletion])).rejects.toThrow();
    expect(database.query(`SELECT attachment_revision FROM workspace_drafts WHERE id = 'draft-1'`).get())
      .toEqual({ attachment_revision: 1 });
    expect(database.query(`SELECT schema_name FROM workspace_schema_metadata WHERE schema_name = '__draft_attachment_revision_guard__'`).get())
      .toBeNull();
  });

  test('rejects a send transaction when an upload reservation races its preflight', async () => {
    const { database, env } = fixture();
    const guard = assertDraftAttachmentSet(env.DB, {
      userId: 'owner-1',
      draftId: 'draft-1',
      expectedRevision: 0,
      attachmentIds: []
    });
    await insertUploadingAttachment(env.DB, {
      id: '019d1234-5678-4abc-8def-3123456789ab',
      userId: 'owner-1',
      draftId: 'draft-1',
      filename: 'racing.txt',
      contentType: 'text/plain',
      size: bytes.byteLength,
      r2Key: 'outbound/v1/2026-08-19/019d1234-5678-4abc-8def-3123456789ab/019d1234-5678-4abc-8def-4123456789ab.bin',
      expectedRevision: 0
    }).run();

    await expect(env.DB.batch([guard, deleteDraft(env.DB, 'owner-1', 'draft-1')])).rejects.toThrow();
    expect(database.query(`SELECT id FROM workspace_drafts WHERE id = 'draft-1'`).get()).toEqual({ id: 'draft-1' });
    expect(database.query(`SELECT schema_name FROM workspace_schema_metadata WHERE schema_name = '__draft_attachment_set_guard__'`).get())
      .toBeNull();
  });
});
