import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { consumeTelegramActionLimit, createTelegramChallenge, findTelegramBinding, hasTelegramTables } from '$lib/server/db/telegram';
import { resolveTelegramConfig } from '$lib/server/telegram/config';
import { createTelegramChallengeToken } from '$lib/server/telegram/utils';
import { telegramFeatureError } from '$lib/server/telegram/workspace';

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'WORKSPACE_UNAVAILABLE', '工作区存储暂不可用。');
  const featureError = telegramFeatureError(resolveTelegramConfig(env));
  if (featureError) throw new ApiError(featureError.status, featureError.code, featureError.message, undefined, undefined, featureError.status >= 500);
  if (!await hasTelegramTables(env.DB)) throw new ApiError(503, 'SCHEMA_NOT_READY', 'Telegram 通知数据结构尚未就绪。');
  const limit = await consumeTelegramActionLimit(env.DB, session.userId, 'bind', Date.now(), 10 * 60 * 1000, 5);
  if (!limit.allowed) throw new ApiError(429, 'TELEGRAM_RATE_LIMITED', `操作过于频繁，请在 ${limit.retryAfterSeconds} 秒后重试。`, undefined, undefined, false);
  const current = await findTelegramBinding(env.DB, session.userId);
  if (current?.state === 'active') throw new ApiError(409, 'TELEGRAM_ALREADY_BOUND', '已有活动绑定，请先解除绑定后再重新绑定。', undefined, undefined, false);
  const token = await createTelegramChallengeToken();
  const challengeId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await createTelegramChallenge(env.DB, session.userId, challengeId, token.tokenHash, expiresAt);
  const config = resolveTelegramConfig(env);
  return apiSuccess(event, {
    state: 'pending',
    expiresAt,
    deepLink: `https://t.me/${config.botUsername}?start=${token.token}`
  });
});
