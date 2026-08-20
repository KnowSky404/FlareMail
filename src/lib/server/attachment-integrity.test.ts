import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  AttachmentIntegrityError,
  MAX_ATTACHMENT_INTEGRITY_BYTES,
  repairInboundAttachmentChecksums,
  sha256Hex,
  verifyAttachmentObject
} from './attachment-integrity';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly db: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async all<T>() { return { results: this.db.query(this.sql).all(...this.values) as T[] }; }
  async run() {
    this.db.query(this.sql).run(...this.values);
    const changes = Number((this.db.query('SELECT changes() AS changes').get() as { changes: number }).changes);
    return { meta: { changes } } as D1Result<unknown>;
  }
}

class Bucket {
  readonly objects = new Map<string, Uint8Array>();
  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const owned = bytes.slice();
    let consumed = false;
    return {
      key,
      size: owned.byteLength,
      body: new Blob([owned]).stream(),
      arrayBuffer: async () => {
        if (consumed) throw new Error('R2 object body was consumed more than once.');
        consumed = true;
        return owned.buffer.slice(owned.byteOffset, owned.byteOffset + owned.byteLength);
      }
    } as unknown as R2ObjectBody;
  }
}

const object = (bytes: Uint8Array, key = 'inbound/object.bin') => ({
  key,
  size: bytes.byteLength,
  body: new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]).stream(),
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
} as unknown as R2ObjectBody);

describe('attachment integrity', () => {
  test('verifies normal bytes and rejects mismatch, size mismatch, and missing objects', async () => {
    const bytes = new TextEncoder().encode('附件内容');
    const digest = await sha256Hex(bytes);
    await expect(verifyAttachmentObject(object(bytes), bytes.byteLength, digest)).resolves.toMatchObject({ state: 'verified', sha256: digest });
    await expect(verifyAttachmentObject(object(bytes), bytes.byteLength, '0'.repeat(64))).rejects.toMatchObject({ reason: 'checksum_mismatch' });
    await expect(verifyAttachmentObject(object(bytes), bytes.byteLength + 1, digest)).rejects.toMatchObject({ reason: 'size_mismatch' });
    await expect(verifyAttachmentObject(null, bytes.byteLength, digest)).rejects.toMatchObject({ reason: 'missing' });
  });

  test('keeps legacy rows downloadable with an explicit degraded result and bounds reads', async () => {
    const bytes = new TextEncoder().encode('legacy');
    const legacy = await verifyAttachmentObject(object(bytes), bytes.byteLength, null);
    expect(legacy.state).toBe('legacy');
    if (legacy.state === 'legacy') expect(new TextDecoder().decode(legacy.bytes)).toBe('legacy');
    const oversized = { size: MAX_ATTACHMENT_INTEGRITY_BYTES + 1, body: new Blob().stream(), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as R2ObjectBody;
    await expect(verifyAttachmentObject(oversized, MAX_ATTACHMENT_INTEGRITY_BYTES + 1, '0'.repeat(64)))
      .rejects.toMatchObject({ reason: 'too_large' });
    const truncated = { size: 6, body: new Blob(['short']).stream(), arrayBuffer: async () => new TextEncoder().encode('short').buffer } as unknown as R2ObjectBody;
    await expect(verifyAttachmentObject(truncated, 6, null)).rejects.toMatchObject({ reason: 'size_mismatch' });
  });

  test('verifies an attachment at the configured ingest boundary', async () => {
    const bytes = new Uint8Array(MAX_ATTACHMENT_INTEGRITY_BYTES);
    bytes[0] = 0x41;
    bytes[bytes.length - 1] = 0x5a;
    const digest = await sha256Hex(bytes);
    await expect(verifyAttachmentObject(object(bytes), bytes.byteLength, digest))
      .resolves.toMatchObject({ state: 'verified', sha256: digest });
  });

  test('repairs only owner-joined legacy rows, is bounded, and is idempotent', async () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(new URL('../../../schema.sql', import.meta.url), 'utf8'));
    db.query(`INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone)
      VALUES ('owner', 'owner@example.test', 'Owner', 'Owner', 'owner@example.test', '', '', 'UTC')`).run();
    db.query(`INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone)
      VALUES ('other', 'other@example.test', 'Other', 'Owner', 'other@example.test', '', '', 'UTC')`).run();
    db.query(`INSERT INTO email_messages (id, "from", "to", timestamp, raw_key, owner_user_id)
      VALUES ('mail-1', 'sender@example.test', 'owner@example.test', '2026-08-20T00:00:00Z', 'raw/mail-1', 'owner')`).run();
    db.query(`INSERT INTO email_messages (id, "from", "to", timestamp, raw_key, owner_user_id)
      VALUES ('mail-2', 'sender@example.test', 'other@example.test', '2026-08-20T00:00:00Z', 'raw/mail-2', 'other')`).run();
    db.query(`INSERT INTO workspace_attachments (id, user_id, message_id, filename, size, r2_key)
      VALUES ('a-legacy', 'owner', 'mail-1', '同名.txt', 6, 'inbound/a-legacy')`).run();
    db.query(`INSERT INTO workspace_attachments (id, user_id, message_id, filename, size, r2_key)
      VALUES ('a-other', 'other', 'mail-2', '同名.txt', 6, 'inbound/a-other')`).run();
    const bucket = new Bucket();
    bucket.objects.set('inbound/a-legacy', new TextEncoder().encode('legacy'));
    bucket.objects.set('inbound/a-other', new TextEncoder().encode('legacy'));
    const d1 = { prepare: (sql: string) => new Statement(db, sql) as unknown as D1PreparedStatement } as D1Database;

    const report = await repairInboundAttachmentChecksums(d1, bucket as unknown as R2Bucket, { limit: 1 });
    expect(report).toMatchObject({ scanned: 1, updated: 0, rows: [{ id: 'a-legacy', status: 'legacy' }] });
    const applied = await repairInboundAttachmentChecksums(d1, bucket as unknown as R2Bucket, { limit: 1, apply: true });
    expect(applied).toMatchObject({ updated: 1, rows: [{ id: 'a-legacy', status: 'updated' }] });
    const repeated = await repairInboundAttachmentChecksums(d1, bucket as unknown as R2Bucket, { limit: 1, apply: true });
    expect(repeated).toMatchObject({ updated: 0, rows: [{ id: 'a-legacy', status: 'verified' }] });
    expect(db.query(`SELECT sha256 FROM workspace_attachments WHERE id = 'a-other'`).get()).toEqual({ sha256: null });

    db.query(`INSERT INTO workspace_attachments (id, user_id, message_id, filename, size, r2_key, sha256)
      VALUES ('a-mismatch', 'owner', 'mail-1', '同名.txt', 6, 'inbound/a-mismatch', ?)`).run('0'.repeat(64));
    bucket.objects.set('inbound/a-mismatch', new TextEncoder().encode('legacy'));
    const mismatchReport = await repairInboundAttachmentChecksums(d1, bucket as unknown as R2Bucket, { afterId: 'a-legacy', limit: 1, repairMismatches: true });
    expect(mismatchReport).toMatchObject({ rows: [{ id: 'a-mismatch', status: 'checksum_mismatch' }] });
    const mismatchApplied = await repairInboundAttachmentChecksums(d1, bucket as unknown as R2Bucket, { afterId: 'a-legacy', limit: 1, apply: true, repairMismatches: true });
    expect(mismatchApplied).toMatchObject({ updated: 1, rows: [{ id: 'a-mismatch', status: 'updated' }] });
  });

  test('reports missing and size-corrupt repair objects without changing D1', async () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(new URL('../../../schema.sql', import.meta.url), 'utf8'));
    db.query(`INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone)
      VALUES ('owner', 'owner@example.test', 'Owner', 'Owner', 'owner@example.test', '', '', 'UTC')`).run();
    db.query(`INSERT INTO email_messages (id, "from", "to", timestamp, raw_key, owner_user_id)
      VALUES ('mail-1', 'sender@example.test', 'owner@example.test', '2026-08-20T00:00:00Z', 'raw/mail-1', 'owner')`).run();
    db.query(`INSERT INTO workspace_attachments (id, user_id, message_id, filename, size, r2_key)
      VALUES ('a-missing', 'owner', 'mail-1', 'missing.txt', 3, 'inbound/missing')`).run();
    db.query(`INSERT INTO workspace_attachments (id, user_id, message_id, filename, size, r2_key)
      VALUES ('a-size', 'owner', 'mail-1', 'size.txt', 9, 'inbound/size')`).run();
    const bucket = new Bucket();
    bucket.objects.set('inbound/size', new TextEncoder().encode('short'));
    const d1 = { prepare: (sql: string) => new Statement(db, sql) as unknown as D1PreparedStatement } as D1Database;
    const report = await repairInboundAttachmentChecksums(d1, bucket as unknown as R2Bucket, { limit: 10 });
    expect(report.rows).toEqual([
      { id: 'a-missing', messageId: 'mail-1', status: 'missing' },
      { id: 'a-size', messageId: 'mail-1', status: 'size_mismatch' }
    ]);
    expect(db.query(`SELECT COUNT(*) AS count FROM workspace_attachments WHERE sha256 IS NOT NULL`).get()).toEqual({ count: 0 });
  });
});
