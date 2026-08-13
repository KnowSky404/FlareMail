import type { RequestHandler } from './$types';
import { fromInboundMessageId, isInboundMessageId, sanitizeContentDisposition } from '$lib/domain/mail';
import { findOwnedInboundMessage } from '$lib/server/db/inbound';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';

const MAX_RAW_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export const GET: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  if (!isInboundMessageId(event.params.id)) return new Response('当前邮件不支持下载原始内容。', { status: 404 });
  if (!env?.DB || !env.BUCKET) return new Response('入站存储服务暂不可用。', { status: 503 });

  const record = await findOwnedInboundMessage(env.DB, session.userId, fromInboundMessageId(event.params.id));
  if (!record) return new Response('找不到对应的原始邮件记录。', { status: 404 });
  if (record.raw_size > MAX_RAW_DOWNLOAD_BYTES) return new Response('原始邮件超出可下载大小限制。', { status: 413 });

  const rawObject = await env.BUCKET.get(record.raw_key);
  if (!rawObject) return new Response('原始邮件对象不存在。', { status: 404 });
  const objectSize = rawObject.size;
  if (objectSize > MAX_RAW_DOWNLOAD_BYTES || (record.raw_size > 0 && objectSize !== record.raw_size)) {
    return new Response('原始邮件完整性校验失败。', { status: 409 });
  }

  return new Response(rawObject.body, { headers: {
    'content-type': 'message/rfc822',
    'content-disposition': sanitizeContentDisposition(`flaremail-${record.id}.eml`),
    'content-length': String(objectSize),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff'
  } });
};
