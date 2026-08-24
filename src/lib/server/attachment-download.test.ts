import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sha256Hex } from '$lib/server/attachment-integrity';
import { GET } from '../../routes/api/workspace/messages/[id]/attachments/[attachmentId]/+server';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly db: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.db.query(this.sql).get(...this.values) as T | null) ?? null; }
  async all<T>() { return { results: this.db.query(this.sql).all(...this.values) as T[] }; }
}

class Bucket {
  readonly objects = new Map<string, Uint8Array>();
  readonly reportedSizes = new Map<string, number>();
  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const owned = bytes.slice();
    return { key, size: this.reportedSizes.get(key) ?? owned.byteLength, body: new Blob([owned]).stream(), arrayBuffer: async () => owned.buffer } as unknown as R2ObjectBody;
  }
}

const fixture = async () => {
  const database = new Database(':memory:');
  database.exec(readFileSync(new URL('../../../schema.sql', import.meta.url), 'utf8'));
  database.query(`INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone)
    VALUES ('owner', 'owner@example.test', 'Owner', 'Owner', 'owner@example.test', '', '', 'UTC')`).run();
  database.query(`INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone)
    VALUES ('other', 'other@example.test', 'Other', 'Owner', 'other@example.test', '', '', 'UTC')`).run();
  database.query(`INSERT INTO email_messages (id, "from", "to", timestamp, raw_key, owner_user_id)
    VALUES ('mail-1', 'sender@example.test', 'owner@example.test', '2026-08-20T00:00:00Z', 'raw/mail-1', 'owner')`).run();
  const bytes = new TextEncoder().encode('first bytes');
  const second = new TextEncoder().encode('second bytes');
  const checksum = await sha256Hex(bytes);
  const secondChecksum = await sha256Hex(second);
  database.query(`INSERT INTO workspace_attachments
    (id, user_id, message_id, filename, size, r2_key, relation_type, state, sha256)
    VALUES ('attachment-1', 'owner', 'mail-1', '中文.txt', ?, 'inbound/object-1', 'inbound', 'ready', ?)`)
    .run(bytes.byteLength, checksum);
  database.query(`INSERT INTO workspace_attachments
    (id, user_id, message_id, filename, size, r2_key, relation_type, state, sha256)
    VALUES ('attachment-2', 'owner', 'mail-1', '中文.txt', ?, 'inbound/object-2', 'inbound', 'ready', ?)`)
    .run(second.byteLength, secondChecksum);
  database.query(`INSERT INTO workspace_attachments
    (id, user_id, message_id, filename, size, r2_key, relation_type, state)
    VALUES ('attachment-legacy', 'owner', 'mail-1', 'legacy.txt', 6, 'inbound/legacy', 'inbound', 'ready')`).run();
  database.query(`INSERT INTO workspace_attachments
    (id, user_id, message_id, filename, size, r2_key, relation_type, state)
    VALUES ('attachment-truncated', 'owner', 'mail-1', 'truncated.txt', 7, 'inbound/truncated', 'inbound', 'ready')`).run();
  const bucket = new Bucket();
  bucket.objects.set('inbound/object-1', bytes);
  bucket.objects.set('inbound/object-2', second);
  bucket.objects.set('inbound/legacy', new TextEncoder().encode('legacy'));
  bucket.objects.set('inbound/truncated', new TextEncoder().encode('short'));
  bucket.reportedSizes.set('inbound/truncated', 7);
  const env = { DB: { prepare: (sql: string) => new Statement(database, sql) as unknown as D1PreparedStatement }, BUCKET: bucket };
  const event = (userId: string, attachmentId: string) => ({
    platform: { env },
    params: { id: 'email:mail-1', attachmentId },
    locals: { workspaceSession: { userId } },
    request: new Request(`https://mail.example.test/api/workspace/messages/email:mail-1/attachments/${attachmentId}`, { headers: { 'X-Request-ID': 'attachment-test' } }),
    url: new URL(`https://mail.example.test/api/workspace/messages/email:mail-1/attachments/${attachmentId}`)
  }) as never;
  return { database, bucket, event };
};

describe('inbound attachment download integrity', () => {
  test('returns verified bytes with safe Chinese filename and separates same-name objects', async () => {
    const { event } = await fixture();
    const first = await GET(event('owner', 'attachment-1'));
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('first bytes');
    expect(first.headers.get('x-content-type-options')).toBe('nosniff');
    expect(first.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    const second = await GET(event('owner', 'attachment-2'));
    expect(await second.text()).toBe('second bytes');
  });

  test('rejects checksum and size corruption, while allowing legacy rows with a degraded log path', async () => {
    const test = await fixture();
    test.bucket.objects.set('inbound/object-1', new TextEncoder().encode('corrupt!!!!'));
    const mismatch = await GET(test.event('owner', 'attachment-1'));
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json()) as Record<string, unknown>).toMatchObject({ ok: false, error: { code: 'ATTACHMENT_CHECKSUM_MISMATCH' } });

    test.database.query(`UPDATE workspace_attachments SET size = 99 WHERE id = 'attachment-2'`).run();
    const size = await GET(test.event('owner', 'attachment-2'));
    expect(size.status).toBe(409);
    expect((await size.json()) as Record<string, unknown>).toMatchObject({ ok: false, error: { code: 'ATTACHMENT_SIZE_MISMATCH' } });

    const legacy = await GET(test.event('owner', 'attachment-legacy'));
    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toBe('legacy');

    const truncated = await GET(test.event('owner', 'attachment-truncated'));
    expect(truncated.status).toBe(409);
    expect((await truncated.json()) as Record<string, unknown>).toMatchObject({ ok: false, error: { code: 'ATTACHMENT_SIZE_MISMATCH' } });
  });

  test('returns distinct safe errors for missing objects, non-owner, and forged IDs', async () => {
    const test = await fixture();
    test.bucket.objects.delete('inbound/object-1');
    const missing = await GET(test.event('owner', 'attachment-1'));
    expect(missing.status).toBe(404);
    expect((await missing.json()) as Record<string, unknown>).toMatchObject({ ok: false, error: { code: 'ATTACHMENT_OBJECT_NOT_FOUND' } });
    const nonOwner = await GET(test.event('other', 'attachment-2'));
    expect(nonOwner.status).toBe(404);
    const forged = await GET(test.event('owner', 'forged-attachment-id'));
    expect(forged.status).toBe(404);
  });
});
