import type { RequestHandler } from './$types';
import { ApiError, apiFailure, apiSuccess, requirePathParam, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { OutboundRateLimitError, retryWorkspaceMessageDelivery } from '$lib/server/workspace';
import { isOutboundGatewayError } from '$lib/server/outbound/gateway';
import { DeliveryNotRetryableError } from '$lib/server/workspace/delivery';

export function _mapDeliveryRetryError(error: unknown) {
  if (error instanceof DeliveryNotRetryableError) {
    return new ApiError(409, 'DELIVERY_NOT_RETRYABLE', '当前邮件已存在，但当前投递状态不允许普通重试。', undefined, { reason: error.reason });
  }
  return null;
}

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  try {
    const result = await retryWorkspaceMessageDelivery(getRequestEnv(event), session, requirePathParam(event, 'id'));
    if (!result) throw new ApiError(404, 'DELIVERY_RETRY_NOT_AVAILABLE', '当前邮件不支持重试投递。');
    return apiSuccess(event, result);
  } catch (error) {
    if (error instanceof OutboundRateLimitError) {
      return apiFailure(
        event,
        new ApiError(429, 'SEND_RATE_LIMITED', `发送过于频繁，请在 ${error.retryAfterSeconds} 秒后重试。`),
        { headers: { 'Retry-After': String(error.retryAfterSeconds) } }
      );
    }
    const retryError = _mapDeliveryRetryError(error);
    if (retryError) throw retryError;
    if (isOutboundGatewayError(error) && error.kind === 'configuration') {
      throw new ApiError(503, 'OUTBOUND_UNAVAILABLE', '出站邮件服务尚未正确配置。');
    }
    if (isOutboundGatewayError(error) && error.kind === 'idempotency_conflict') {
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '投递服务拒绝了幂等重试。');
    }
    if (isOutboundGatewayError(error) && error.kind === 'idempotency_expired') {
      throw new ApiError(409, 'DELIVERY_REVIEW_REQUIRED', 'Provider 幂等窗口已过。请先检查 Resend Dashboard、收件箱和投递时间线，再决定是否重新发送。', undefined, { reviewRequired: true, providerWindowHours: 24 });
    }
    throw error;
  }
});
