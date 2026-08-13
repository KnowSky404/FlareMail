import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, requirePathParam, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { retryWorkspaceMessageDelivery } from '$lib/server/workspace';
import { isOutboundGatewayError } from '$lib/server/outbound/gateway';

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  try {
    const result = await retryWorkspaceMessageDelivery(getRequestEnv(event), session, requirePathParam(event, 'id'));
    if (!result) throw new ApiError(404, 'DELIVERY_RETRY_NOT_AVAILABLE', '当前邮件不支持重试投递。');
    return apiSuccess(event, result);
  } catch (error) {
    if (isOutboundGatewayError(error) && error.kind === 'configuration') {
      throw new ApiError(503, 'OUTBOUND_UNAVAILABLE', '出站邮件服务尚未正确配置。');
    }
    if (isOutboundGatewayError(error) && error.kind === 'idempotency_conflict') {
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '投递服务拒绝了幂等重试。');
    }
    throw error;
  }
});
