import { sanitizeFilename } from '$lib/domain/mail';
import { utf8ByteLength } from '$lib/domain/utf8';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import {
  bumpDraftAttachmentRevision,
  deleteDraftAttachmentAttempt,
  findOwnedDraftAttachment,
  insertDraftAttachmentCancellation,
  insertDraftAttachment,
  listAttachmentsForDraft,
  markDraftAttachmentDeletePending,
  markDraftAttachmentFailed,
  markDraftAttachmentReady,
  renameDraftAttachment,
  restartDraftAttachment,
  type StoredAttachmentRow
} from '$lib/server/db/attachments';
import { findOwnedDraft } from '$lib/server/db/drafts';
import {
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  MAX_OUTBOUND_ATTACHMENT_COUNT,
  MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES
} from '$lib/server/outbound/gateway';
import type { WorkspaceContext } from '$lib/server/workspace/shared';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ATTACHMENT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
const MAX_FILENAME_BYTES = 255;
const MAX_MIME_BYTES = 127;

export class DraftAttachmentError extends Error {
  constructor(
    readonly code:
      | 'ATTACHMENT_VALIDATION_FAILED'
      | 'ATTACHMENT_CONFLICT'
      | 'ATTACHMENT_NOT_FOUND'
      | 'ATTACHMENT_UPLOAD_FAILED'
      | 'ATTACHMENT_STORAGE_UNAVAILABLE',
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'DraftAttachmentError';
  }
}

function requireStorage(env: CloudflareEnv | undefined, session: WorkspaceContext) {
  if (!env?.DB || !env.BUCKET || session.storage !== 'd1') {
    throw new DraftAttachmentError('ATTACHMENT_STORAGE_UNAVAILABLE', '附件存储服务暂不可用。', 503);
  }
  return env as CloudflareEnv & { DB: D1Database; BUCKET: R2Bucket };
}

function safeAttachmentId(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!ATTACHMENT_ID_PATTERN.test(normalized)) {
    throw new DraftAttachmentError('ATTACHMENT_VALIDATION_FAILED', '附件标识无效。');
  }
  return normalized;
}

function safeFilename(value: string) {
  const filename = sanitizeFilename(value);
  if (!value.trim() || !filename || utf8ByteLength(filename) > MAX_FILENAME_BYTES) {
    throw new DraftAttachmentError('ATTACHMENT_VALIDATION_FAILED', '附件名称无效或过长。');
  }
  return filename;
}

function safeContentType(value: string | null) {
  const contentType = (value || 'application/octet-stream').split(';', 1)[0]!.trim().toLowerCase();
  if (!MIME_TYPE_PATTERN.test(contentType) || utf8ByteLength(contentType) > MAX_MIME_BYTES) {
    throw new DraftAttachmentError('ATTACHMENT_VALIDATION_FAILED', '附件 MIME 类型无效。');
  }
  return contentType;
}

function safeSize(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_OUTBOUND_ATTACHMENT_BYTES) {
    throw new DraftAttachmentError(
      'ATTACHMENT_VALIDATION_FAILED',
      `单个附件不能超过 ${MAX_OUTBOUND_ATTACHMENT_BYTES} 字节。`
    );
  }
  return value;
}

function safeRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DraftAttachmentError('ATTACHMENT_VALIDATION_FAILED', '附件版本无效。');
  }
  return value;
}

function safeChecksum(value: string) {
  const checksum = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(checksum)) {
    throw new DraftAttachmentError('ATTACHMENT_VALIDATION_FAILED', '附件校验和无效。');
  }
  return checksum;
}

function summary(row: StoredAttachmentRow) {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    inline: row.disposition === 'inline',
    contentId: row.content_id,
    disposition: row.disposition,
    state: row.state,
    sha256: row.sha256
  } as const;
}

async function ownedDraft(
  db: D1Database,
  userId: string,
  draftId: string,
  expectedRevision?: number
) {
  const draft = await findOwnedDraft(db, userId, draftId);
  if (!draft) throw new DraftAttachmentError('ATTACHMENT_NOT_FOUND', '附件所属草稿不存在。', 404);
  const revision = Number(draft.attachment_revision ?? 0);
  if (expectedRevision !== undefined && revision !== expectedRevision) {
    throw new DraftAttachmentError('ATTACHMENT_CONFLICT', '草稿附件已在其他会话中更新，请重新载入。', 409);
  }
  return { draft, revision };
}

export async function draftAttachmentSnapshot(db: D1Database, userId: string, draftId: string) {
  const { draft, revision } = await ownedDraft(db, userId, draftId);
  const rows = await listAttachmentsForDraft(db, userId, draftId);
  return {
    attachments: rows.filter((row) => row.state !== 'delete_pending').map(summary),
    attachmentRevision: revision,
    draftUpdatedAt: draft.updated_at
  };
}

function attachmentKey(attachmentId: string, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return `outbound/v1/${day}/${attachmentId}/${crypto.randomUUID()}.bin`;
}

function cleanupAfter(now = Date.now()) {
  return new Date(now + 24 * 60 * 60 * 1000).toISOString();
}

function boundedUploadBody(body: ReadableStream | null, expectedSize: number) {
  if (!body) {
    if (expectedSize !== 0) throw new Error('Upload body was missing.');
    return { body: new Uint8Array(), completion: Promise.resolve() };
  }
  if (typeof FixedLengthStream !== 'undefined') {
    const fixed = new FixedLengthStream(expectedSize);
    return { body: fixed.readable, completion: body.pipeTo(fixed.writable) };
  }
  let received = 0;
  const counted = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > expectedSize || received > MAX_OUTBOUND_ATTACHMENT_BYTES) {
        throw new Error('Upload body exceeded the declared size.');
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (received !== expectedSize) throw new Error('Upload body did not match the declared size.');
    }
  }));
  return { body: counted, completion: Promise.resolve() };
}

function requireChanged(results: D1Result[]) {
  if (results.length !== 2 || results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
    throw new DraftAttachmentError('ATTACHMENT_CONFLICT', '草稿附件已在其他会话中更新，请重新载入。', 409);
  }
}

export async function uploadDraftAttachment(
  env: CloudflareEnv | undefined,
  session: WorkspaceContext,
  input: {
    draftId: string;
    attachmentId: string;
    filename: string;
    contentType: string | null;
    size: number;
    sha256: string;
    attachmentRevision: number;
    body: ReadableStream | null;
  }
) {
  const storage = requireStorage(env, session);
  const attachmentId = safeAttachmentId(input.attachmentId);
  const filename = safeFilename(input.filename);
  const contentType = safeContentType(input.contentType);
  const size = safeSize(input.size);
  const checksum = safeChecksum(input.sha256);
  const expectedRevision = safeRevision(input.attachmentRevision);
  await ownedDraft(storage.DB, session.userId, input.draftId, expectedRevision);

  const existing = await findOwnedDraftAttachment(storage.DB, session.userId, input.draftId, attachmentId);
  if (existing?.state === 'ready') {
    if (existing.sha256 === checksum && existing.size === size) {
      return draftAttachmentSnapshot(storage.DB, session.userId, input.draftId);
    }
    throw new DraftAttachmentError('ATTACHMENT_CONFLICT', '该附件标识已用于其他内容。', 409);
  }
  if (existing && existing.state !== 'failed') {
    throw new DraftAttachmentError('ATTACHMENT_CONFLICT', '附件正在上传、删除或已由其他请求更新。', 409);
  }
  if (existing) {
    try {
      await storage.BUCKET.delete(existing.r2_key);
    } catch {
      throw new DraftAttachmentError(
        'ATTACHMENT_STORAGE_UNAVAILABLE',
        '旧附件仍在等待存储清理，请稍后重试。',
        503
      );
    }
  }

  const rows = await listAttachmentsForDraft(storage.DB, session.userId, input.draftId);
  const active = rows.filter((row) => row.state === 'ready' || row.state === 'uploading');
  if (active.length >= MAX_OUTBOUND_ATTACHMENT_COUNT) {
    throw new DraftAttachmentError('ATTACHMENT_VALIDATION_FAILED', `每封邮件最多 ${MAX_OUTBOUND_ATTACHMENT_COUNT} 个附件。`);
  }
  const totalBytes = active.reduce((total, row) => total + row.size, 0) + size;
  if (totalBytes > MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES) {
    throw new DraftAttachmentError(
      'ATTACHMENT_VALIDATION_FAILED',
      `附件总大小不能超过 ${MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES} 字节。`
    );
  }

  const now = new Date().toISOString();
  const r2Key = attachmentKey(attachmentId);
  try {
    const writeAttempt = existing ? restartDraftAttachment : insertDraftAttachment;
    const inserted = await writeAttempt(storage.DB, {
      id: attachmentId,
      userId: session.userId,
      draftId: input.draftId,
      filename,
      contentType,
      size,
      r2Key,
      createdAt: now,
      deleteAfter: cleanupAfter(),
      expectedRevision
    }).run();
    if (Number(inserted.meta?.changes ?? 0) !== 1) {
      throw new DraftAttachmentError('ATTACHMENT_CONFLICT', '草稿附件已在其他会话中更新，请重新载入。', 409);
    }
    const upload = boundedUploadBody(input.body, size);
    const [object] = await Promise.all([
      storage.BUCKET.put(r2Key, upload.body, {
        sha256: checksum,
        httpMetadata: { contentType },
        customMetadata: { attachmentId, lifecycle: 'draft' }
      }),
      upload.completion
    ]);
    if (!object || object.size !== size) {
      throw new Error('R2 object size did not match the declared upload size.');
    }
    const completedAt = new Date().toISOString();
    const results = await storage.DB.batch([
      markDraftAttachmentReady(storage.DB, {
        userId: session.userId,
        draftId: input.draftId,
        attachmentId,
        r2Key,
        sha256: checksum,
        size,
        updatedAt: completedAt,
        expectedRevision
      }),
      bumpDraftAttachmentRevision(storage.DB, {
        userId: session.userId,
        draftId: input.draftId,
        updatedAt: completedAt,
        expectedRevision
      })
    ]);
    requireChanged(results);
    const ready = await findOwnedDraftAttachment(storage.DB, session.userId, input.draftId, attachmentId);
    if (ready?.state !== 'ready' || ready.sha256 !== checksum || ready.r2_key !== r2Key) {
      throw new DraftAttachmentError('ATTACHMENT_CONFLICT', '附件状态发生并发变化，请重试。', 409);
    }
    return draftAttachmentSnapshot(storage.DB, session.userId, input.draftId);
  } catch (error) {
    let objectDeleted = false;
    try {
      await storage.BUCKET.delete(r2Key);
      objectDeleted = true;
    } catch {
      // Keep the attempt row as the durable cleanup reference.
    }
    if (
      (error instanceof DraftAttachmentError && error.code === 'ATTACHMENT_CONFLICT')
      || (error instanceof Error && /unique constraint|constraint failed/iu.test(error.message))
    ) {
      if (objectDeleted) {
        await deleteDraftAttachmentAttempt(storage.DB, session.userId, input.draftId, attachmentId, r2Key).run().catch(() => undefined);
      } else {
        await markDraftAttachmentFailed(storage.DB, {
          userId: session.userId,
          draftId: input.draftId,
          attachmentId,
          r2Key,
          updatedAt: new Date().toISOString(),
          deleteAfter: cleanupAfter()
        }).run().catch(() => undefined);
      }
      throw error instanceof DraftAttachmentError
        ? error
        : new DraftAttachmentError('ATTACHMENT_CONFLICT', '草稿附件已在其他会话中更新，请重新载入。', 409);
    }
    await markDraftAttachmentFailed(storage.DB, {
      userId: session.userId,
      draftId: input.draftId,
      attachmentId,
      r2Key,
      updatedAt: new Date().toISOString(),
      deleteAfter: cleanupAfter()
    }).run().catch(() => undefined);
    throw new DraftAttachmentError('ATTACHMENT_UPLOAD_FAILED', '附件上传失败，文件仍可在写信面板中重试。', 503);
  }
}

export async function updateDraftAttachmentName(
  env: CloudflareEnv | undefined,
  session: WorkspaceContext,
  input: { draftId: string; attachmentId: string; filename: string; attachmentRevision: number }
) {
  const storage = requireStorage(env, session);
  const expectedRevision = safeRevision(input.attachmentRevision);
  const attachmentId = safeAttachmentId(input.attachmentId);
  const filename = safeFilename(input.filename);
  await ownedDraft(storage.DB, session.userId, input.draftId, expectedRevision);
  const attachment = await findOwnedDraftAttachment(storage.DB, session.userId, input.draftId, attachmentId);
  if (!attachment || attachment.state !== 'ready') {
    throw new DraftAttachmentError('ATTACHMENT_NOT_FOUND', '找不到可重命名的附件。', 404);
  }
  const now = new Date().toISOString();
  const results = await storage.DB.batch([
    renameDraftAttachment(storage.DB, {
      userId: session.userId,
      draftId: input.draftId,
      attachmentId,
      filename,
      updatedAt: now,
      expectedRevision
    }),
    bumpDraftAttachmentRevision(storage.DB, {
      userId: session.userId,
      draftId: input.draftId,
      updatedAt: now,
      expectedRevision
    })
  ]);
  requireChanged(results);
  return draftAttachmentSnapshot(storage.DB, session.userId, input.draftId);
}

export async function removeDraftAttachment(
  env: CloudflareEnv | undefined,
  session: WorkspaceContext,
  input: { draftId: string; attachmentId: string; attachmentRevision: number }
) {
  const storage = requireStorage(env, session);
  const expectedRevision = safeRevision(input.attachmentRevision);
  const attachmentId = safeAttachmentId(input.attachmentId);
  await ownedDraft(storage.DB, session.userId, input.draftId, expectedRevision);
  const attachment = await findOwnedDraftAttachment(storage.DB, session.userId, input.draftId, attachmentId);
  if (!attachment) {
    const now = new Date().toISOString();
    try {
      const results = await storage.DB.batch([
        insertDraftAttachmentCancellation(storage.DB, {
          id: attachmentId,
          userId: session.userId,
          draftId: input.draftId,
          filename: 'cancelled-upload',
          contentType: 'application/octet-stream',
          size: 0,
          r2Key: attachmentKey(attachmentId),
          createdAt: now,
          deleteAfter: cleanupAfter(),
          expectedRevision
        }),
        bumpDraftAttachmentRevision(storage.DB, {
          userId: session.userId,
          draftId: input.draftId,
          updatedAt: now,
          expectedRevision
        })
      ]);
      requireChanged(results);
      return draftAttachmentSnapshot(storage.DB, session.userId, input.draftId);
    } catch (error) {
      if (!(error instanceof Error) || !/unique constraint|constraint failed/iu.test(error.message)) throw error;
      const latest = await ownedDraft(storage.DB, session.userId, input.draftId);
      return removeDraftAttachment(env, session, {
        ...input,
        attachmentRevision: latest.revision
      });
    }
  }
  if (attachment.state !== 'delete_pending') {
    const now = new Date().toISOString();
    const results = await storage.DB.batch([
      markDraftAttachmentDeletePending(storage.DB, {
        userId: session.userId,
        draftId: input.draftId,
        attachmentId,
        deleteAfter: cleanupAfter(),
        updatedAt: now,
        expectedRevision
      }),
      bumpDraftAttachmentRevision(storage.DB, {
        userId: session.userId,
        draftId: input.draftId,
        updatedAt: now,
        expectedRevision
      })
    ]);
    requireChanged(results);
  }
  try {
    await storage.BUCKET.delete(attachment.r2_key);
    await deleteDraftAttachmentAttempt(storage.DB, session.userId, input.draftId, attachmentId, attachment.r2_key).run();
  } catch {
    return {
      ...await draftAttachmentSnapshot(storage.DB, session.userId, input.draftId),
      cleanupPending: true
    };
  }
  return draftAttachmentSnapshot(storage.DB, session.userId, input.draftId);
}
