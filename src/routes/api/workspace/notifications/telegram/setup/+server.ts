import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { consumeTelegramActionLimit, hasTelegramTables } from '$lib/server/db/telegram';
import { configureTelegramWebhook, TelegramApiError } from '$lib/server/telegram/api';
import { resolveTelegramConfig } from '$lib/server/telegram/config';
import { telegramFeatureError } from '$lib/server/telegram/workspace';

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'WORKSPACE_UNAVAILABLE', '工作区存储暂不可用。');

  const featureError = telegramFeatureError(resolveTelegramConfig(env));
  if (featureError) throw new ApiError(featureError.status, featureError.code, featureError.message, undefined, undefined, featureError.status >= 500);
  if (!await hasTelegramTables(env.DB)) throw new ApiError(503, 'SCHEMA_NOT_READY', 'Telegram 通知数据结构尚未就绪。');

  const limit = await consumeTelegramActionLimit(env.DB, session.userId, 'setup', Date.now(), 10 * 60 * 1000, 5);
  if (!limit.allowed) throw new ApiError(429, 'TELEGRAM_RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSeconds} 秒后重试。`, undefined, undefined, false);

  const config = resolveTelegramConfig(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('telegram setup timeout'), config.timeoutMs);
  try {
    try {
      const result = await configureTelegramWebhook(env, { signal: controller.signal });
      return apiSuccess(event, {
        connected: true,
        botUsername: result.botUsername,
        webhookPath: result.webhookPath
      });
    } catch (error) {
      if (error instanceof TelegramApiError) {
        const status = error.kind === 'rate_limited' ? 429 : error.kind === 'permanent' ? 502 : 503;
        const stage = error.code.startsWith('identity_') ? '验证机器人身份' : error.code.startsWith('webhook_') ? '注册 Webhook' : '检查配置';
        throw new ApiError(status, `TELEGRAM_SETUP_${error.code.toUpperCase()}`, `Telegram ${stage}失败（${error.code}）。`, undefined, undefined, status >= 500);
      }
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
});
