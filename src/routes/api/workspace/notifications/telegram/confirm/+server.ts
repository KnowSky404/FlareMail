import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { activateTelegramBinding, consumeTelegramActionLimit, hasTelegramTables } from '$lib/server/db/telegram';
import { resolveTelegramConfig } from '$lib/server/telegram/config';
import { telegramFeatureError, telegramWorkspaceStatus } from '$lib/server/telegram/workspace';

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'WORKSPACE_UNAVAILABLE', '工作区存储暂不可用。');
  const featureError = telegramFeatureError(resolveTelegramConfig(env));
  if (featureError) throw new ApiError(featureError.status, featureError.code, featureError.message, undefined, undefined, featureError.status >= 500);
  if (!await hasTelegramTables(env.DB)) throw new ApiError(503, 'SCHEMA_NOT_READY', 'Telegram 通知数据结构尚未就绪。');
  const limit = await consumeTelegramActionLimit(env.DB, session.userId, 'confirm', Date.now(), 10 * 60 * 1000, 10);
  if (!limit.allowed) throw new ApiError(429, 'TELEGRAM_RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSeconds} 秒后重试。`, undefined, undefined, false);
  if (!await activateTelegramBinding(env.DB, session.userId)) throw new ApiError(409, 'TELEGRAM_CANDIDATE_REQUIRED', '请先从 Telegram 私聊发送绑定链接中的 /start。', undefined, undefined, false);
  return apiSuccess(event, await telegramWorkspaceStatus(env, session.userId));
});
