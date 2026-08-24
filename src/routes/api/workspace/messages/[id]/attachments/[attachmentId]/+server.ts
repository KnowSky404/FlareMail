import type { RequestHandler } from './$types';
import { fromInboundMessageId, isInboundMessageId, sanitizeContentDisposition } from '$lib/domain/mail';
import { findOwnedAttachment } from '$lib/server/db/attachments';
import { getRequestEnv } from '$lib/server/workspace-api';
import { authorizeCidAttachment } from '$lib/server/workspace/cid-capability';
import { SAFE_INLINE_IMAGE_TYPES } from '$lib/server/workspace/html';

export const GET: RequestHandler = async (event) => {
  const env = getRequestEnv(event);
  if (!env?.DB || !env.BUCKET) return new Response('附件存储服务暂不可用。', { status: 503 });

  const inbound = isInboundMessageId(event.params.id);
  const messageId = inbound ? fromInboundMessageId(event.params.id) : event.params.id;
  const userId = event.locals.workspaceSession?.userId ?? (inbound ? await authorizeCidAttachment(
    env.DB, event.params.id, event.params.attachmentId, event.url.searchParams
  ) : null);
  if (!userId) return new Response('请先登录工作台。', { status: 401 });
  const attachment = await findOwnedAttachment(env.DB, userId, messageId, event.params.attachmentId);
  if (!attachment || attachment.state !== 'ready') return new Response('找不到附件。', { status: 404 });
  const object = await env.BUCKET.get(attachment.r2_key);
  if (!object || object.size !== attachment.size) return new Response('附件完整性校验失败。', { status: 409 });
  if (attachment.relation_type === 'message') {
    if (!attachment.sha256) return new Response('附件完整性校验失败。', { status: 409 });
    const bytes = new Uint8Array(await object.arrayBuffer());
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== attachment.sha256) return new Response('附件完整性校验失败。', { status: 409 });
    const contentType = attachment.content_type.trim().toLowerCase();
    return new Response(bytes, { headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': sanitizeContentDisposition(attachment.filename, 'attachment'),
      'content-length': String(attachment.size),
      'cache-control': 'private, no-store',
      'content-security-policy': "default-src 'none'; sandbox",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-flaremail-content-type': contentType
    } });
  }
  const contentType = attachment.content_type.trim().toLowerCase();
  const inline = event.url.searchParams.get('inline') === '1' && Boolean(attachment.inline) && SAFE_INLINE_IMAGE_TYPES.has(contentType);

  return new Response(object.body, { headers: {
    'content-type': inline ? contentType : 'application/octet-stream',
    'content-disposition': sanitizeContentDisposition(attachment.filename, inline ? 'inline' : 'attachment'),
    'content-length': String(attachment.size),
    'cache-control': 'private, no-store',
    'content-security-policy': "default-src 'none'; sandbox",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
  } });
};
