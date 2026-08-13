import type { RequestHandler } from './$types';
import { fromInboundMessageId, isInboundMessageId, sanitizeContentDisposition } from '$lib/domain/mail';
import { findOwnedAttachment } from '$lib/server/db/attachments';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';

export const GET: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  if (!isInboundMessageId(event.params.id)) return new Response('找不到附件。', { status: 404 });
  if (!env?.DB || !env.BUCKET) return new Response('附件存储服务暂不可用。', { status: 503 });

  const messageId = fromInboundMessageId(event.params.id);
  const attachment = await findOwnedAttachment(env.DB, session.userId, messageId, event.params.attachmentId);
  if (!attachment) return new Response('找不到附件。', { status: 404 });
  const object = await env.BUCKET.get(attachment.r2_key);
  if (!object || object.size !== attachment.size) return new Response('附件完整性校验失败。', { status: 409 });

  return new Response(object.body, { headers: {
    'content-type': 'application/octet-stream',
    'content-disposition': sanitizeContentDisposition(attachment.filename),
    'content-length': String(attachment.size),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff'
  } });
};
