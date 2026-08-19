import type { CloudflareEnv } from './cloudflare';
import { parseMessageIds, normalizeMessageId, normalizeThreadSubject, sanitizeFilename } from '$lib/domain/mail';
import { insertAttachment } from '$lib/server/db/attachments';
import { insertBodyObject } from '$lib/server/db/body';
import { claimInboundIngest, completeInboundIngestClaim, completeInboundIngestClaimForExistingMessage, findInboundByDedupeKey, findInboundOwnerId, insertInboundMessage, releaseInboundIngestClaim } from '$lib/server/db/inbound';
import { findUserInboundNotificationSettings } from '$lib/server/db/users';
import { parseInboundMime, InboundMimeLimitError, InboundMimeParseError } from '$lib/server/inbound/parser';
import { sendAutomaticReply, sendInboundNotification } from './outbound/system';
import { isInboundNotificationEnabled } from './workspace/profile';
import { BodyCanonicalLimitError, prepareBodyObject, projectBody, putBodyObject } from '$lib/server/body';

export const DEFAULT_INBOUND_LIMITS = Object.freeze({
  rawBytes: 25 * 1024 * 1024,
  attachmentCount: 50,
  attachmentBytes: 15 * 1024 * 1024,
  attachmentTotalBytes: 24 * 1024 * 1024
});

export class InboundRawLimitError extends Error {
  readonly code = 'INBOUND_RAW_LIMIT';
  constructor(readonly limit: number, readonly actual: number) {
    super('Inbound message exceeds the configured raw size limit.');
    this.name = 'InboundRawLimitError';
  }
}

const configuredLimit = (value: string | undefined, fallback: number, maximum: number) => {
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed > maximum) throw new Error('INBOUND_LIMIT_CONFIGURATION_INVALID');
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const toIsoTimestamp = (value: string | null | undefined) => {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
};

const addressLabel = (address: { name: string; address: string } | null, fallback: string) =>
  address?.address ? (address.name ? `${address.name} <${address.address}>` : address.address) : fallback;

const addressList = (addresses: Array<{ name: string; address: string }>) =>
  addresses.map((address) => address.name ? `${address.name} <${address.address}>` : address.address).join(', ');

const bytesToBase64Url = (value: ArrayBuffer) => {
  let binary = '';
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

async function sha256(value: ArrayBuffer | Uint8Array | string) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const input = bytes instanceof Uint8Array ? bytes.slice().buffer : value;
  return bytesToBase64Url(await crypto.subtle.digest('SHA-256', input as ArrayBuffer));
}

export async function createInboundDedupeKey(messageId: string | null, recipient: string, raw: ArrayBuffer) {
  const normalizedRecipient = recipient.trim().toLowerCase();
  const normalizedId = messageId ? normalizeMessageId(messageId) : null;
  return normalizedId
    ? `rfc:${normalizedId}:to:${normalizedRecipient}`
    : `sha256:${await sha256(raw)}:to:${normalizedRecipient}`;
}

export async function readBoundedRawEmail(
  stream: ReadableStream<Uint8Array>,
  declaredSize: number,
  limit: number
): Promise<ArrayBuffer> {
  if (declaredSize > limit) throw new InboundRawLimitError(limit, declaredSize);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel('inbound raw size limit exceeded');
        throw new InboundRawLimitError(limit, total);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw.buffer;
}

function inboundThreadKey(input: { messageId: string | null; inReplyTo: string | null; references: string | null; subject: string; from: string }) {
  const rfcId = parseMessageIds(input.references)[0] ?? parseMessageIds(input.inReplyTo)[0] ?? parseMessageIds(input.messageId)[0];
  return rfcId ? `rfc:${rfcId}` : `${normalizeThreadSubject(input.subject)}::${input.from.trim().toLowerCase()}`;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && /unique constraint|constraint failed/iu.test(error.message);
}

async function removeObjects(bucket: R2Bucket, keys: string[]) {
  await Promise.all(keys.map((key) => bucket.delete(key).catch(() => undefined)));
}

function safeLog(event: string, detail: Record<string, string | number | boolean | null>) {
  console.log(JSON.stringify({ event, ...detail }));
}

const rejectReason = (code: string) => ({
  INBOUND_RAW_LIMIT: 'Message exceeds the inbound size limit.',
  INBOUND_MIME_LIMIT: 'Message exceeds the MIME attachment limit.',
  INBOUND_MIME_PARSE: 'Message could not be parsed as MIME.',
  INBOUND_MIME_PARSE_FAILED: 'Message could not be parsed as MIME.'
}[code] ?? 'Message was rejected by the inbound safety limits.').slice(0, 128);

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: CloudflareEnv,
  ctx?: ExecutionContext
) {
  const startedAt = Date.now();
  const correlationId = crypto.randomUUID();
  if (!env.DB || !env.BUCKET) throw new Error('INBOUND_STORAGE_UNAVAILABLE');

  const rawLimit = configuredLimit(env.INBOUND_MAX_RAW_BYTES, DEFAULT_INBOUND_LIMITS.rawBytes, DEFAULT_INBOUND_LIMITS.rawBytes);
  let raw: ArrayBuffer;
  let parsed;
  const rawStartedAt = Date.now();
  try {
    raw = await readBoundedRawEmail(message.raw, message.rawSize, rawLimit);
    safeLog('inbound_phase', { correlationId, phase: 'raw_read', bytes: raw.byteLength, durationMs: Date.now() - rawStartedAt });
    const mimeStartedAt = Date.now();
    parsed = await parseInboundMime(raw, {
      maxAttachmentCount: configuredLimit(env.INBOUND_MAX_ATTACHMENT_COUNT, DEFAULT_INBOUND_LIMITS.attachmentCount, 100),
      maxAttachmentSize: configuredLimit(env.INBOUND_MAX_ATTACHMENT_BYTES, DEFAULT_INBOUND_LIMITS.attachmentBytes, DEFAULT_INBOUND_LIMITS.attachmentBytes),
      maxAttachmentTotalSize: configuredLimit(env.INBOUND_MAX_ATTACHMENT_TOTAL_BYTES, DEFAULT_INBOUND_LIMITS.attachmentTotalBytes, DEFAULT_INBOUND_LIMITS.attachmentTotalBytes)
    });
    safeLog('inbound_phase', { correlationId, phase: 'mime_parse', bytes: raw.byteLength, attachments: parsed.attachments.length, durationMs: Date.now() - mimeStartedAt });
  } catch (error) {
    if (error instanceof InboundRawLimitError || error instanceof InboundMimeLimitError || error instanceof InboundMimeParseError) {
      const detail: Record<string, string | number | boolean | null> = {
        correlationId,
        code: error.code,
        durationMs: Date.now() - startedAt,
        bytes: error instanceof InboundRawLimitError ? error.actual : message.rawSize
      };
      if (error instanceof InboundMimeLimitError) {
        if (error.kind === 'attachment_count') detail.count = error.actual;
        else detail.bytes = error.actual;
      }
      safeLog('inbound_rejected', detail);
      message.setReject(rejectReason(error.code));
      return;
    }
    throw error;
  }

  if (raw.byteLength !== message.rawSize && message.rawSize > 0) {
    safeLog('inbound_size_mismatch', { correlationId, declaredBytes: message.rawSize, actualBytes: raw.byteLength });
  }

  const recipient = message.to.trim().toLowerCase();
  const messageId = parsed.messageId ?? message.headers.get('message-id');
  const dedupeKey = await createInboundDedupeKey(messageId, recipient, raw);
  const existing = await findInboundByDedupeKey(env.DB, dedupeKey);
  if (existing) {
    await completeInboundIngestClaimForExistingMessage(env.DB, dedupeKey);
    safeLog('inbound_duplicate', { correlationId, messageId: existing.id, durationMs: Date.now() - startedAt });
    return;
  }

  const date = toIsoTimestamp(parsed.date ?? message.headers.get('date'));
  const claim = await claimInboundIngest(env.DB, dedupeKey, (storageId) => `inbound/${date.slice(0, 10)}/${storageId}/message.eml`);
  if (!claim) {
    safeLog('inbound_claim_busy', { correlationId, code: 'INBOUND_CLAIM_BUSY', durationMs: Date.now() - startedAt });
    return;
  }
  if (claim.status === 'completed') {
    safeLog('inbound_duplicate', { correlationId, code: 'INBOUND_CLAIM_COMPLETED', durationMs: Date.now() - startedAt });
    return;
  }
  const storageId = claim.storageId;
  const claimedExisting = await findInboundByDedupeKey(env.DB, dedupeKey);
  if (claimedExisting) {
    await completeInboundIngestClaim(env.DB, dedupeKey, claim.claimToken);
    safeLog('inbound_duplicate', { correlationId, code: 'INBOUND_MESSAGE_EXISTS', durationMs: Date.now() - startedAt });
    return;
  }
  const rawKey = `inbound/${date.slice(0, 10)}/${storageId}/message.eml`;
  const ownerUserId = await findInboundOwnerId(env.DB, recipient);
  const ownerKey = ownerUserId ?? 'unassigned';
  const writtenKeys = [rawKey];
  const projected = projectBody(parsed.text, parsed.html, parsed.snippet || '(empty body)');
  const attachmentRows = parsed.attachments.map((attachment, index) => {
    const id = `${storageId.slice(0, 24)}-${String(index + 1).padStart(3, '0')}`;
    const filename = sanitizeFilename(attachment.filename);
    const r2Key = `inbound/${date.slice(0, 10)}/${storageId}/attachments/${id}/${encodeURIComponent(filename)}`;
    writtenKeys.push(r2Key);
    return { id, userId: ownerKey, messageId: storageId, filename, contentType: attachment.mimeType,
      size: attachment.size, inline: attachment.inline, contentId: attachment.contentId, r2Key, content: attachment.content };
  });

  let d1Finalized = false;
  let bodyObject: Awaited<ReturnType<typeof prepareBodyObject>> = null;
  try {
    try {
      bodyObject = await prepareBodyObject('email_message', storageId, parsed.text, parsed.html);
    } catch (error) {
      if (!(error instanceof BodyCanonicalLimitError)) throw error;
      // The original RFC822 object remains the lossless source of truth. For
      // unusually expansive MIME decoding, persist bounded projections rather
      // than failing before the raw message reaches R2.
      safeLog('inbound_body_projection_only', {
        correlationId,
        code: error.code,
        bytes: error.actual,
        limit: error.limit
      });
      bodyObject = null;
    }
    if (bodyObject) writtenKeys.push(bodyObject.key);
    const r2StartedAt = Date.now();
    await env.BUCKET.put(rawKey, raw, { httpMetadata: { contentType: 'message/rfc822' }, customMetadata: { messageId: storageId } });
    if (bodyObject) await putBodyObject(env.BUCKET, bodyObject);
    await Promise.all(attachmentRows.map((attachment) => env.BUCKET.put(attachment.r2Key, attachment.content, {
      httpMetadata: { contentType: attachment.contentType },
      customMetadata: { messageId: storageId, attachmentId: attachment.id }
    })));
    safeLog('inbound_phase', { correlationId, phase: 'r2_persist', bytes: raw.byteLength, attachments: attachmentRows.length, durationMs: Date.now() - r2StartedAt });

    const from = addressLabel(parsed.from, message.from);
    const subject = parsed.subject.trim() || message.headers.get('subject')?.trim() || '(no subject)';
    const statements = [insertInboundMessage(env.DB, {
      id: storageId,
      messageId,
      from,
      to: recipient,
      cc: addressList(parsed.cc),
      subject,
      timestamp: date,
      snippet: projected.snippet,
      textBody: bodyObject ? projected.textBody : parsed.text,
      htmlBody: bodyObject ? projected.htmlBody : parsed.html,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      threadKey: inboundThreadKey({ messageId, inReplyTo: parsed.inReplyTo, references: parsed.references, subject, from }),
      dedupeKey,
      rawKey,
      rawSize: raw.byteLength,
      ownerUserId,
      bodyObjectId: bodyObject?.id ?? null
    }), ...(bodyObject ? [insertBodyObject(env.DB, {
      id: bodyObject.id, owner_user_id: ownerUserId, entity_type: 'email_message', entity_id: storageId,
      r2_key: bodyObject.key, size_bytes: bodyObject.sizeBytes, sha256: bodyObject.sha256,
      text_bytes: bodyObject.textBytes, html_bytes: bodyObject.htmlBytes, createdAt: date
    })] : []), ...attachmentRows.map(({ content: _content, ...attachment }) => insertAttachment(env.DB, attachment))];
    const d1StartedAt = Date.now();
    await env.DB.batch(statements);
    safeLog('inbound_phase', { correlationId, phase: 'd1_persist', bytes: raw.byteLength, attachments: attachmentRows.length, durationMs: Date.now() - d1StartedAt });
    d1Finalized = true;
    await completeInboundIngestClaim(env.DB, dedupeKey, claim.claimToken);
  } catch (error) {
    let duplicate = false;
    if (isUniqueConstraintError(error)) {
      try {
        duplicate = Boolean(await findInboundByDedupeKey(env.DB, dedupeKey));
      } catch {
        duplicate = false;
      }
    }
    if (!duplicate && !d1Finalized) {
      await removeObjects(env.BUCKET, writtenKeys);
      await releaseInboundIngestClaim(env.DB, dedupeKey, claim.claimToken).catch(() => undefined);
    }
    if (duplicate) {
      safeLog('inbound_duplicate', { correlationId, messageId: storageId, durationMs: Date.now() - startedAt });
      return;
    }
    safeLog('inbound_storage_failed', { correlationId, code: 'INBOUND_STORAGE_FAILED', durationMs: Date.now() - startedAt });
    throw error;
  }

  const followUpTasks = [
    (async () => {
      // The owner is resolved from the addressed recipient and is checked
      // again before dispatch. An unowned message never inherits another
      // user's notification preference.
      if (!ownerUserId) return { sent: false, reason: 'Inbound message has no workspace owner.' };
      const owner = await findUserInboundNotificationSettings(env.DB, ownerUserId);
      if (!owner || !isInboundNotificationEnabled(owner)) return { sent: false, reason: 'The owner disabled inbound notifications.' };
      return sendInboundNotification(env, { storageId, from: message.from, to: recipient, subject: parsed.subject || '(no subject)',
        timestamp: date, snippet: parsed.snippet });
    })().catch(() => {
      safeLog('inbound_notification_failed', { correlationId, messageId: storageId });
      return null;
    }),
    sendAutomaticReply(message, env, storageId).catch(() => {
      safeLog('inbound_auto_reply_failed', { correlationId, messageId: storageId });
      return null;
    })
  ];
  if (ctx) ctx.waitUntil(Promise.all(followUpTasks));
  else await Promise.all(followUpTasks);
  safeLog('inbound_stored', { correlationId, messageId: storageId, rawBytes: raw.byteLength,
    attachments: attachmentRows.length, owned: Boolean(ownerUserId), durationMs: Date.now() - startedAt });
}
