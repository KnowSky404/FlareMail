import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';
import { retryWorkspaceMessageDelivery } from '$lib/server/workspace';
import { isOutboundGatewayError } from '$lib/server/outbound/gateway';

export const POST: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  let result;
  try {
    result = await retryWorkspaceMessageDelivery(env, session, event.params.id);
  } catch (error) {
    if (isOutboundGatewayError(error) && error.kind === 'configuration') {
      return json({ ok: false, code: 'OUTBOUND_UNAVAILABLE', error: '出站邮件服务尚未正确配置。' }, { status: 503 });
    }
    if (isOutboundGatewayError(error) && error.kind === 'idempotency_conflict') {
      return json({ ok: false, code: 'IDEMPOTENCY_CONFLICT', error: '投递服务拒绝了幂等重试。' }, { status: 409 });
    }
    throw error;
  }

  if (!result) {
    return json(
      {
        ok: false,
        error: '当前邮件不支持重试投递。'
      },
      { status: 404 }
    );
  }

  return json({
    ok: true,
    ...result
  });
};
