import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { ComposeInput } from '$lib/domain/mail';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';
import { sendWorkspaceMessage } from '$lib/server/workspace';
import { isOutboundGatewayError } from '$lib/server/outbound/gateway';

export const POST: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);
  const payload = (await event.request.json()) as ComposeInput;
  const env = getRequestEnv(event);

  if (!payload.toEmail.trim() || !payload.subject.trim() || !payload.body.trim()) {
    return json(
      {
        ok: false,
        error: '收件人、主题和正文不能为空。'
      },
      { status: 400 }
    );
  }

  try {
    return json({
      ok: true,
      ...(await sendWorkspaceMessage(env, session, payload, {
        requestId: event.request.headers.get('Idempotency-Key')
      }))
    });
  } catch (error) {
    if (isOutboundGatewayError(error) && error.kind === 'configuration') {
      return json({ ok: false, code: 'OUTBOUND_UNAVAILABLE', error: '出站邮件服务尚未正确配置。' }, { status: 503 });
    }
    if (isOutboundGatewayError(error) && error.kind === 'client_error') {
      return json({ ok: false, code: 'IDEMPOTENCY_KEY_REQUIRED', error: '新邮件必须提供有效的 Idempotency-Key。' }, { status: 400 });
    }
    if (isOutboundGatewayError(error) && error.kind === 'idempotency_conflict') {
      return json({ ok: false, code: 'IDEMPOTENCY_CONFLICT', error: '相同幂等键对应了不同的发送内容。' }, { status: 409 });
    }
    throw error;
  }
};
