import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, requirePathParam, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { consumeTelegramActionLimit, hasTelegramTables, retryTelegramDelivery } from '$lib/server/db/telegram';
import { resolveTelegramConfig } from '$lib/server/telegram/config';
import { dispatchTelegramOutbox } from '$lib/server/telegram/dispatcher';
import { telegramFeatureError } from '$lib/server/telegram/workspace';

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'WORKSPACE_UNAVAILABLE', '工作区存储暂不可用。');
  const featureError = telegramFeatureError(resolveTelegramConfig(env));
  if (featureError) throw new ApiError(featureError.status, featureError.code, featureError.message, undefined, undefined, featureError.status >= 500);
  if (!await hasTelegramTables(env.DB)) throw new ApiError(503, 'SCHEMA_NOT_READY', 'Telegram 通知数据结构尚未就绪。');
  const limit = await consumeTelegramActionLimit(env.DB, session.userId, 'retry', Date.now(), 10 * 60 * 1000, 10);
  if (!limit.allowed) throw new ApiError(429, 'TELEGRAM_RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSeconds} 秒后重试。`, undefined, undefined, false);
  const id = requirePathParam(event, 'id');
  const current = await env.DB.prepare(`
    SELECT status FROM workspace_telegram_deliveries WHERE id = ? AND owner_user_id = ?
  `).bind(id, session.userId).first<{ status: string }>();
  if (!await retryTelegramDelivery(env.DB, session.userId, id)) throw new ApiError(404, 'TELEGRAM_DELIVERY_NOT_RETRYABLE', '通知不存在、已发送或不允许重试。', undefined, undefined, false);
  const ctx = event.platform?.context ?? event.platform?.ctx;
  ctx?.waitUntil(dispatchTelegramOutbox(env, { limit: 1, timeBudgetMs: 2_000 }));
  return apiSuccess(event, { queued: true, warning: current?.status === 'unknown_delivery' ? 'unknown_delivery' : null });
});
