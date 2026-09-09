import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { hasTelegramTables, listTelegramDeliveries } from '$lib/server/db/telegram';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const env = getRequestEnv(event);
  if (!env?.DB || !await hasTelegramTables(env.DB)) throw new ApiError(503, 'SCHEMA_NOT_READY', 'Telegram 通知数据结构尚未就绪。');
  const limit = Number(event.url.searchParams.get('limit') ?? 20);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new ApiError(400, 'INVALID_LIMIT', '分页参数无效。', undefined, undefined, false);
  return apiSuccess(event, { deliveries: (await listTelegramDeliveries(env.DB, session.userId, limit)).map((delivery) => ({
    id: delivery.id,
    emailMessageId: delivery.email_message_id,
    status: delivery.status,
    attempts: delivery.attempts,
    maxAttempts: delivery.max_attempts,
    subject: delivery.subject,
    receivedAt: delivery.received_at,
    lastErrorCode: delivery.last_error_code,
    createdAt: delivery.created_at,
    completedAt: delivery.completed_at,
    manualRetryWarning: delivery.status === 'unknown_delivery'
  })) });
});
