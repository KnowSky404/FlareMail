import type { RequestHandler } from './$types';
import type { RequestEvent } from '@sveltejs/kit';
import { ApiError, apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { findTelegramBinding, hasTelegramTables, updateTelegramSettings } from '$lib/server/db/telegram';
import { resolveTelegramConfig } from '$lib/server/telegram/config';
import { telegramFeatureError, telegramWorkspaceStatus } from '$lib/server/telegram/workspace';

async function requireTelegramSchema(event: RequestEvent) {
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'WORKSPACE_UNAVAILABLE', '工作区存储暂不可用。');
  const featureError = telegramFeatureError(resolveTelegramConfig(env));
  if (featureError) throw new ApiError(featureError.status, featureError.code, featureError.message, undefined, undefined, featureError.status >= 500);
  if (!await hasTelegramTables(env.DB)) throw new ApiError(503, 'SCHEMA_NOT_READY', 'Telegram 通知数据结构尚未就绪。');
  return env;
}

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'WORKSPACE_UNAVAILABLE', '工作区存储暂不可用。');
  return apiSuccess(event, await telegramWorkspaceStatus(env, session.userId));
});

export const PATCH: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const env = await requireTelegramSchema(event);
  const body = await readJsonBody<{ enabled?: unknown; privacyMode?: unknown; summaryEnabled?: unknown }>(event, { maxBytes: 8 * 1024 });
  const keys = ['enabled', 'privacyMode', 'summaryEnabled'] as const;
  if (!keys.some((key) => typeof body?.[key] === 'boolean')) throw new ApiError(400, 'INVALID_TELEGRAM_SETTINGS', '至少提供一个布尔设置。', undefined, undefined, false);
  for (const key of keys) {
    if (body?.[key] !== undefined && typeof body[key] !== 'boolean') throw new ApiError(400, 'INVALID_TELEGRAM_SETTINGS', 'Telegram 设置值无效。', undefined, undefined, false);
  }
  const binding = await findTelegramBinding(env.DB, session.userId);
  if (!binding || binding.state !== 'active') throw new ApiError(409, 'TELEGRAM_NOT_BOUND', '请先完成 Telegram 绑定确认。', undefined, undefined, false);
  const updated = await updateTelegramSettings(env.DB, session.userId, {
    enabled: body.enabled as boolean | undefined,
    privacyMode: body.privacyMode as boolean | undefined,
    summaryEnabled: body.summaryEnabled as boolean | undefined
  });
  return apiSuccess(event, { settings: updated ? {
    enabled: updated.enabled === 1,
    privacyMode: updated.privacy_mode === 1,
    summaryEnabled: updated.summary_enabled === 1
  } : null });
});

export const PUT = PATCH;
