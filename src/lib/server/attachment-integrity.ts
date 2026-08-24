import type { StoredAttachmentRow } from '$lib/server/db/attachments';

/** The inbound parser rejects anything larger than this value by default. */
export const MAX_ATTACHMENT_INTEGRITY_BYTES = 15 * 1024 * 1024;

const SHA256_HEX = /^[a-f0-9]{64}$/u;

export type AttachmentIntegrityFailure =
  | 'missing'
  | 'size_mismatch'
  | 'checksum_mismatch'
  | 'too_large'
  | 'storage_error';

export class AttachmentIntegrityError extends Error {
  readonly code = 'ATTACHMENT_INTEGRITY_FAILED';

  constructor(readonly reason: AttachmentIntegrityFailure, readonly verifiedBytes?: Uint8Array) {
    super('Attachment integrity verification failed.');
    this.name = 'AttachmentIntegrityError';
  }
}

export type AttachmentVerification =
  | { state: 'verified'; bytes: Uint8Array; sha256: string }
  | { state: 'legacy'; bytes: Uint8Array };

export function attachmentArrayBuffer(value: Uint8Array): ArrayBuffer {
  if (value.buffer instanceof ArrayBuffer && value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) {
    return value.buffer;
  }
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array): Promise<string> {
  const input = value instanceof Uint8Array ? attachmentArrayBuffer(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function safeExpectedChecksum(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  return SHA256_HEX.test(normalized) ? normalized : null;
}

/**
 * Verify the R2 metadata and, when available, the complete object bytes.
 * Legacy rows deliberately remain size-only so old mail is not made
 * unavailable while the bounded repair operation backfills sha256.
 */
export async function verifyAttachmentObject(
  object: R2ObjectBody | null,
  expectedSize: number,
  expectedSha256: string | null,
  maxBytes = MAX_ATTACHMENT_INTEGRITY_BYTES
): Promise<AttachmentVerification> {
  if (!object) throw new AttachmentIntegrityError('missing');
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || object.size !== expectedSize) {
    throw new AttachmentIntegrityError('size_mismatch');
  }

  const checksum = safeExpectedChecksum(expectedSha256);
  if (expectedSha256 !== null && checksum === null) {
    throw new AttachmentIntegrityError('checksum_mismatch');
  }
  if (!checksum) {
    if (expectedSize > maxBytes) throw new AttachmentIntegrityError('too_large');
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await object.arrayBuffer());
    } catch {
      throw new AttachmentIntegrityError('storage_error');
    }
    if (bytes.byteLength !== expectedSize) throw new AttachmentIntegrityError('size_mismatch');
    return { state: 'legacy', bytes };
  }
  if (expectedSize > maxBytes) throw new AttachmentIntegrityError('too_large');

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await object.arrayBuffer());
  } catch {
    throw new AttachmentIntegrityError('storage_error');
  }
  if (bytes.byteLength !== expectedSize) throw new AttachmentIntegrityError('size_mismatch');
  const actual = await sha256Hex(attachmentArrayBuffer(bytes));
  if (actual !== checksum) throw new AttachmentIntegrityError('checksum_mismatch', bytes);
  return { state: 'verified', bytes, sha256: actual };
}

export function logAttachmentIntegrity(
  event: 'attachment_integrity_failed' | 'attachment_integrity_degraded',
  details: { requestId?: string | null; attachmentId: string; relationType: string; reason?: string }
) {
  const requestId = details.requestId?.trim().match(/^[A-Za-z0-9._:-]{1,128}$/u)?.[0] ?? undefined;
  const attachmentId = details.attachmentId.trim().match(/^[A-Za-z0-9._:-]{1,256}$/u)?.[0] ?? 'invalid';
  const relationType = details.relationType.trim().match(/^[a-z-]{1,32}$/u)?.[0] ?? 'unknown';
  const reason = details.reason?.trim().match(/^[a-z_]{1,32}$/u)?.[0];
  console.warn(JSON.stringify({ level: 'warn', event, ...(requestId ? { requestId } : {}), attachmentId, relationType, ...(reason ? { reason } : {}) }));
}

type RepairRow = Pick<StoredAttachmentRow, 'id' | 'user_id' | 'message_id' | 'r2_key' | 'size' | 'sha256'>;

export type AttachmentRepairStatus = 'updated' | 'verified' | 'legacy' | 'missing' | 'size_mismatch' | 'checksum_mismatch' | 'too_large' | 'storage_error' | 'update_failed';

export interface AttachmentRepairResult {
  scanned: number;
  updated: number;
  rows: Array<{ id: string; messageId: string; status: AttachmentRepairStatus }>;
  nextCursor: string | null;
}

/**
 * Bounded, owner-joined repair/audit operation. It is report-only unless
 * apply is explicitly set, and UPDATE remains guarded by the current NULL
 * checksum (or repairMismatches) predicate for idempotent retries.
 */
export async function repairInboundAttachmentChecksums(
  db: D1Database,
  bucket: R2Bucket,
  options: { limit?: number; afterId?: string | null; apply?: boolean; repairMismatches?: boolean } = {}
): Promise<AttachmentRepairResult> {
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
  const afterId = options.afterId?.trim() || null;
  const cursorClause = afterId ? ' AND a.id > ?' : '';
  const query = `
    SELECT a.id, a.user_id, a.message_id, a.r2_key, a.size, a.sha256
    FROM workspace_attachments AS a
    JOIN email_messages AS e ON e.id = a.message_id AND e.owner_user_id = a.user_id
    WHERE a.relation_type = 'inbound' AND a.state = 'ready'${cursorClause}
    ORDER BY a.id ASC LIMIT ?
  `;
  const result = afterId
    ? await db.prepare(query).bind(afterId, limit).all<RepairRow>()
    : await db.prepare(query).bind(limit).all<RepairRow>();
  const rows = result.results ?? [];
  const output: AttachmentRepairResult['rows'] = [];
  let updated = 0;

  for (const row of rows) {
    let object: R2ObjectBody | null;
    try {
      object = await bucket.get(row.r2_key);
    } catch {
      output.push({ id: row.id, messageId: row.message_id, status: 'storage_error' });
      continue;
    }
    let verification: AttachmentVerification;
    try {
      verification = await verifyAttachmentObject(object, row.size, row.sha256);
    } catch (error) {
      const status = error instanceof AttachmentIntegrityError ? error.reason : 'storage_error';
      if (status === 'checksum_mismatch' && row.sha256 && options.repairMismatches) {
        try {
          const bytes = error instanceof AttachmentIntegrityError ? error.verifiedBytes : undefined;
          if (!bytes) throw new Error('Verified bytes unavailable.');
          if (bytes.byteLength !== row.size) {
            output.push({ id: row.id, messageId: row.message_id, status: 'size_mismatch' });
            continue;
          }
          const digest = await sha256Hex(attachmentArrayBuffer(bytes));
          if (!options.apply) {
            output.push({ id: row.id, messageId: row.message_id, status: 'checksum_mismatch' });
            continue;
          }
          const update = await db.prepare(`
            UPDATE workspace_attachments SET sha256 = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ? AND user_id = ? AND message_id = ? AND relation_type = 'inbound' AND sha256 = ?
          `).bind(digest, row.id, row.user_id, row.message_id, row.sha256).run();
          if (Number(update.meta?.changes ?? 0) === 1) {
            updated += 1;
            output.push({ id: row.id, messageId: row.message_id, status: 'updated' });
          } else output.push({ id: row.id, messageId: row.message_id, status: 'update_failed' });
        } catch {
          output.push({ id: row.id, messageId: row.message_id, status: 'storage_error' });
        }
        continue;
      }
      output.push({ id: row.id, messageId: row.message_id, status });
      continue;
    }
    if (verification.state === 'legacy') {
      if (row.size > MAX_ATTACHMENT_INTEGRITY_BYTES) {
        output.push({ id: row.id, messageId: row.message_id, status: 'too_large' });
        continue;
      }
      const digest = await sha256Hex(attachmentArrayBuffer(verification.bytes));
      if (!options.apply) {
        output.push({ id: row.id, messageId: row.message_id, status: 'legacy' });
        continue;
      }
      const update = await db.prepare(`
        UPDATE workspace_attachments SET sha256 = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND user_id = ? AND message_id = ? AND relation_type = 'inbound' AND sha256 IS NULL
      `).bind(digest, row.id, row.user_id, row.message_id).run();
      if (Number(update.meta?.changes ?? 0) === 1) {
        updated += 1;
        output.push({ id: row.id, messageId: row.message_id, status: 'updated' });
      } else output.push({ id: row.id, messageId: row.message_id, status: 'verified' });
      continue;
    }
    output.push({ id: row.id, messageId: row.message_id, status: 'verified' });
  }

  return { scanned: rows.length, updated, rows: output, nextCursor: rows.at(-1)?.id ?? null };
}
