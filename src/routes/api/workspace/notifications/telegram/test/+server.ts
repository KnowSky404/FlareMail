import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { consumeTelegramActionLimit, findTelegramBinding, hasTelegramTables, reserveTelegramDeliveryScope } from '$lib/server/db/telegram';
import { resolveTelegramConfig } from '$lib/server/telegram/config';
import { TelegramApiError, sendTelegramMessage } from '$lib/server/telegram/api';
import { telegramFeatureError } from '$lib/server/telegram/workspace';

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'WORKSPACE_UNAVAILABLE', '工作区存储暂不可用。');
  const featureError = telegramFeatureError(resolveTelegramConfig(env));
  if (featureError) throw new ApiError(featureError.status, featureError.code, featureError.message, undefined, undefined, featureError.status >= 500);
  if (!await hasTelegramTables(env.DB)) throw new ApiError(503, 'SCHEMA_NOT_READY', 'Telegram 通知数据结构尚未就绪。');
  const binding = await findTelegramBinding(env.DB, session.userId);
  if (!binding || binding.state !== 'active' || binding.enabled !== 1 || !binding.telegram_chat_id) throw new ApiError(409, 'TELEGRAM_NOT_ENABLED', '请先确认绑定并开启 Telegram 通知。', undefined, undefined, false);
  const limit = await consumeTelegramActionLimit(env.DB, session.userId, 'test', Date.now(), 10 * 60 * 1000, 5);
  if (!limit.allowed) throw new ApiError(429, 'TELEGRAM_RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSeconds} 秒后重试。`, undefined, undefined, false);
  const now = new Date().toISOString();
  for (const [scope, interval] of [['bot', 1_000], [`user:${session.userId}`, 1_000], [`chat:${binding.telegram_chat_id}`, 1_000]] as const) {
    if (!await reserveTelegramDeliveryScope(env.DB, scope, now, new Date(Date.parse(now) + interval).toISOString())) {
      throw new ApiError(429, 'TELEGRAM_RATE_LIMITED', 'Telegram 通知发送过于频繁，请稍后重试。', undefined, undefined, false);
    }
  }
  // The binding snapshot used to reserve rate-limit scopes can become stale
  // while the user unbinds or rebinds. Revalidate the exact authorization
  // version immediately before this direct, fixed-content test send.
  const latestBinding = await findTelegramBinding(env.DB, session.userId);
  if (!latestBinding || latestBinding.state !== 'active' || latestBinding.enabled !== 1 ||
    latestBinding.binding_id !== binding.binding_id ||
    latestBinding.authorization_version !== binding.authorization_version ||
    latestBinding.telegram_chat_id !== binding.telegram_chat_id) {
    throw new ApiError(409, 'TELEGRAM_BINDING_CHANGED', 'Telegram 绑定已变化，请刷新后重试。', undefined, undefined, false);
  }
  const config = resolveTelegramConfig(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('telegram timeout'), config.timeoutMs);
  try {
    try {
      await sendTelegramMessage(env, {
        chatId: latestBinding.telegram_chat_id,
        text: 'FlareMail 测试通知：Telegram 通道工作正常。',
        disableWebPagePreview: true
      }, { signal: controller.signal });
    } catch (error) {
      if (error instanceof TelegramApiError) {
        const status = error.kind === 'rate_limited' ? 429 : error.kind === 'permanent' ? 502 : 503;
        throw new ApiError(status, `TELEGRAM_${error.code.toUpperCase()}`, 'Telegram 测试通知未发送。', undefined, undefined, status >= 500);
      }
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
  return apiSuccess(event, { sent: true });
});
