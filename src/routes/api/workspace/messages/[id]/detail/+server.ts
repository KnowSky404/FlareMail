import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fromInboundMessageId, isInboundMessageId } from '$lib/mock/mailbox';
import type { StoredEmailMessage } from '$lib/server/cloudflare';
import { parseInboundEmail } from '$lib/server/inbound-email';
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
    return json(
      {
        ok: false,
        error: '当前邮件不支持加载原始详情。'
      },
      { status: 404 }
    );
  }

  if (!env?.DB || !env.BUCKET) {
    return json(
      {
        ok: false,
        error: '运行时缺少 D1 或 R2 绑定。'
      },
      { status: 503 }
    );
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
    return json(
      {
        ok: false,
        error: '找不到对应的原始邮件记录。'
      },
      { status: 404 }
    );
  }

  const rawObject = await env.BUCKET.get(record.raw_key);

  if (!rawObject) {
    return json(
      {
        ok: false,
        error: '原始邮件对象不存在。'
      },
      { status: 404 }
    );
  }

  return json({
    ok: true,
    detail: parseInboundEmail(await rawObject.arrayBuffer())
  });
};
