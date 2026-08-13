import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fromInboundMessageId, isInboundMessageId } from '$lib/domain/mail';
import { listAttachmentsForMessage } from '$lib/server/db/attachments';
import { findOwnedInboundMessage } from '$lib/server/db/inbound';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';

export const GET: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  if (!isInboundMessageId(event.params.id)) return json({ ok: false, error: '当前邮件不支持加载入站详情。' }, { status: 404 });
  if (!env?.DB) return json({ ok: false, error: '入站存储服务暂不可用。' }, { status: 503 });

  const messageId = fromInboundMessageId(event.params.id);
  const record = await findOwnedInboundMessage(env.DB, session.userId, messageId);
  if (!record) return json({ ok: false, error: '找不到对应的入站邮件。' }, { status: 404 });
  const attachments = await listAttachmentsForMessage(env.DB, messageId);

  return json({
    ok: true,
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
        downloadUrl: `/api/workspace/messages/${encodeURIComponent(event.params.id)}/attachments/${encodeURIComponent(attachment.id)}`
      }))
    }
  }, { headers: { 'cache-control': 'private, no-store' } });
};
