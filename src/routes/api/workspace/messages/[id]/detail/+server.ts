import type { RequestHandler } from './$types';
import { fromInboundMessageId, isInboundMessageId } from '$lib/domain/mail';
import { listAttachmentsForMessage } from '$lib/server/db/attachments';
import { findBodyObject } from '$lib/server/db/body';
import { readBodyObject } from '$lib/server/body';
import { findOwnedInboundMessage } from '$lib/server/db/inbound';
import { ApiError, apiSuccess, requirePathParam, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  const routeMessageId = requirePathParam(event, 'id');
  if (!isInboundMessageId(routeMessageId)) throw new ApiError(404, 'INBOUND_DETAIL_NOT_FOUND', '当前邮件不支持加载入站详情。');
  if (!env?.DB) throw new ApiError(503, 'INBOUND_STORAGE_UNAVAILABLE', '入站存储服务暂不可用。');
  const messageId = fromInboundMessageId(routeMessageId);
  const record = await findOwnedInboundMessage(env.DB, session.userId, messageId);
  if (!record) throw new ApiError(404, 'INBOUND_MESSAGE_NOT_FOUND', '找不到对应的入站邮件。');
  let body = record.text_body.trim() || record.snippet;
  let hasHtml = Boolean(record.html_body.trim());
  if (record.body_object_id) {
    if (!env.BUCKET) throw new ApiError(503, 'INBOUND_STORAGE_UNAVAILABLE', '入站正文存储服务暂不可用。');
    const object = await findBodyObject(env.DB, record.body_object_id, session.userId, 'email_message', messageId);
    if (!object) throw new ApiError(404, 'BODY_OBJECT_NOT_FOUND', '入站正文对象不存在。');
    try {
      const canonical = await readBodyObject(env.BUCKET, object.r2_key, object.size_bytes, object.sha256);
      body = canonical.textBody;
      hasHtml = Boolean(canonical.htmlBody.trim());
    } catch (error) {
      throw new ApiError(409, 'BODY_OBJECT_INTEGRITY', '入站正文完整性校验失败。', undefined, { reason: error instanceof Error ? error.message : 'unknown' });
    }
  }
  const attachments = await listAttachmentsForMessage(env.DB, session.userId, messageId);
  return apiSuccess(event, {
    detail: {
      body,
      rawSize: record.raw_size,
      hasHtml,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.content_type,
        size: attachment.size,
        inline: Boolean(attachment.inline),
        contentId: attachment.content_id,
        downloadUrl: `/api/workspace/messages/${encodeURIComponent(routeMessageId)}/attachments/${encodeURIComponent(attachment.id)}`
      }))
    }
  });
});
