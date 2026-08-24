import type { RequestHandler } from './$types';
import { fromInboundMessageId, isInboundMessageId, sanitizeContentDisposition } from '$lib/domain/mail';
import { findOwnedAttachment } from '$lib/server/db/attachments';
import { getRequestEnv } from '$lib/server/workspace-api';
import { authorizeCidAttachment } from '$lib/server/workspace/cid-capability';
import { SAFE_INLINE_IMAGE_TYPES } from '$lib/server/workspace/html';
import { ApiError, getRequestId, withApiHandler } from '$lib/server/http/api';
import { attachmentArrayBuffer, AttachmentIntegrityError, logAttachmentIntegrity, verifyAttachmentObject, type AttachmentVerification } from '$lib/server/attachment-integrity';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const requestId = getRequestId(event);
  const env = getRequestEnv(event);
  if (!env?.DB || !env.BUCKET) throw new ApiError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE', '附件存储服务暂不可用。');

  const routeMessageId = event.params.id ?? '';
  const routeAttachmentId = event.params.attachmentId ?? '';
  const inbound = isInboundMessageId(routeMessageId);
  const messageId = inbound ? fromInboundMessageId(routeMessageId) : routeMessageId;
  const userId = event.locals.workspaceSession?.userId ?? (inbound ? await authorizeCidAttachment(
    env.DB, routeMessageId, routeAttachmentId, event.url.searchParams
  ) : null);
  if (!userId) throw new ApiError(401, 'AUTHENTICATION_REQUIRED', '请先登录工作台。', undefined, undefined, false);
  const attachment = await findOwnedAttachment(env.DB, userId, messageId, routeAttachmentId);
  if (!attachment || attachment.state !== 'ready') throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', '找不到附件。', undefined, undefined, false);
  if (attachment.relation_type === 'message' && !attachment.sha256) {
    logAttachmentIntegrity('attachment_integrity_failed', { requestId, attachmentId: attachment.id, relationType: attachment.relation_type, reason: 'checksum_missing' });
    throw new ApiError(409, 'ATTACHMENT_CHECKSUM_MISSING', '附件完整性校验失败。', undefined, undefined, false);
  }
  let verification: AttachmentVerification;
  try {
    verification = await verifyAttachmentObject(await env.BUCKET.get(attachment.r2_key), attachment.size, attachment.sha256);
  } catch (error) {
    const reason = error instanceof AttachmentIntegrityError ? error.reason : 'storage_error';
    logAttachmentIntegrity('attachment_integrity_failed', { requestId, attachmentId: attachment.id, relationType: attachment.relation_type, reason });
    if (reason === 'missing') throw new ApiError(404, 'ATTACHMENT_OBJECT_NOT_FOUND', '附件对象不存在。', undefined, undefined, false);
    if (reason === 'size_mismatch') throw new ApiError(409, 'ATTACHMENT_SIZE_MISMATCH', '附件大小校验失败。', undefined, undefined, false);
    if (reason === 'checksum_mismatch') throw new ApiError(409, 'ATTACHMENT_CHECKSUM_MISMATCH', '附件完整性校验失败。', undefined, undefined, false);
    if (reason === 'too_large') throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', '附件超过可安全校验的大小限制。', undefined, undefined, false);
    throw new ApiError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE', '附件存储服务暂不可用。');
  }
  if (verification.state === 'legacy') {
    logAttachmentIntegrity('attachment_integrity_degraded', { requestId, attachmentId: attachment.id, relationType: attachment.relation_type, reason: 'legacy_checksum_null' });
  }
  const contentType = attachment.content_type?.trim().toLowerCase() || 'application/octet-stream';
  const inline = event.url.searchParams.get('inline') === '1' && Boolean(attachment.inline) && SAFE_INLINE_IMAGE_TYPES.has(contentType);
  const body = attachmentArrayBuffer(verification.bytes);

  return new Response(body, { headers: {
    'content-type': attachment.relation_type === 'message' ? 'application/octet-stream' : (inline ? contentType : 'application/octet-stream'),
    'content-disposition': sanitizeContentDisposition(attachment.filename, attachment.relation_type === 'message' || !inline ? 'attachment' : 'inline'),
    'content-length': String(attachment.size),
    'cache-control': 'private, no-store',
    'content-security-policy': "default-src 'none'; sandbox",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
  } });
});
