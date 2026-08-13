import type { RequestHandler } from './$types';
import { fromInboundMessageId, isInboundMessageId } from '$lib/domain/mail';
import { listAttachmentsForMessage } from '$lib/server/db/attachments';
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
  const attachments = await listAttachmentsForMessage(env.DB, messageId);
  return apiSuccess(event, {
    detail: {
      body: record.text_body.trim() || record.snippet,
      rawSize: record.raw_size,
      hasHtml: Boolean(record.html_body.trim()),
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
