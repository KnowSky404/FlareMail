import type { RequestHandler } from './$types';
import { fromInboundMessageId, isInboundMessageId } from '$lib/mock/mailbox';
import type { StoredEmailMessage } from '$lib/server/cloudflare';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';

const findWorkspaceMessage = (session: App.Locals['workspaceSession'], messageId: string) =>
  session
    ? session.mailbox.inbox.find((message) => message.id === messageId) ??
      session.mailbox.sent.find((message) => message.id === messageId) ??
      session.mailbox.drafts.find((message) => message.id === messageId) ??
      null
    : null;

export const GET: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  const workspaceMessage = findWorkspaceMessage(session, event.params.id);

  if (!workspaceMessage || !isInboundMessageId(workspaceMessage.id)) {
    return new Response('当前邮件不支持下载原始内容。', { status: 404 });
  }

  if (!env?.DB || !env.BUCKET) {
    return new Response('运行时缺少 D1 或 R2 绑定。', { status: 503 });
  }

  const record = await env.DB.prepare(
    `
      SELECT
        id,
        message_id,
        "from",
        "to",
        subject,
        "timestamp",
        snippet,
        raw_key,
        raw_size,
        created_at
      FROM email_messages
      WHERE id = ?
    `
  ).bind(fromInboundMessageId(workspaceMessage.id)).first<StoredEmailMessage>();

  if (!record) {
    return new Response('找不到对应的原始邮件记录。', { status: 404 });
  }

  const rawObject = await env.BUCKET.get(record.raw_key);

  if (!rawObject) {
    return new Response('原始邮件对象不存在。', { status: 404 });
  }

  return new Response(rawObject.body, {
    headers: {
      'content-type': 'message/rfc822',
      'content-disposition': `attachment; filename="flaremail-${record.id}.eml"`,
      'content-length': String(record.raw_size)
    }
  });
};
