import type { CloudflareEnv } from '$lib/server/cloudflare';
import { findTelegramBinding, hasTelegramTables, listTelegramDeliveries } from '$lib/server/db/telegram';
import { resolveTelegramConfig } from './config';

export async function telegramWorkspaceStatus(env: CloudflareEnv, userId: string) {
  const config = resolveTelegramConfig(env);
  const schemaReady = Boolean(env.DB) && await hasTelegramTables(env.DB);
  const binding = schemaReady ? await findTelegramBinding(env.DB, userId) : null;
  const deliveries = schemaReady ? await listTelegramDeliveries(env.DB, userId, 10) : [];
  const user = schemaReady ? await env.DB!.prepare(`SELECT timezone FROM workspace_users WHERE id = ?`).bind(userId).first<{ timezone: string }>() : null;
  return {
    globalEnabled: config.enabled,
    configReady: config.ready,
    schemaReady,
    botUsername: config.botUsername,
    timezone: user?.timezone?.trim() || 'UTC',
    userBound: binding?.state === 'active' || binding?.state === 'candidate',
    userEnabled: binding?.state === 'active' && binding.enabled === 1,
    binding: binding ? {
      state: binding.state,
      enabled: binding.enabled === 1,
      privacyMode: binding.privacy_mode === 1,
      summaryEnabled: binding.summary_enabled === 1,
      telegramUsername: binding.telegram_username,
      telegramDisplayName: binding.telegram_display_name,
      candidateExpiresAt: binding.candidate_expires_at,
      boundAt: binding.bound_at,
      confirmedAt: binding.confirmed_at,
      lastSentAt: binding.last_sent_at,
      lastErrorCode: binding.last_error_code,
      lastErrorAt: binding.last_error_at
    } : null,
    recentDeliveries: deliveries.map((delivery) => ({
      id: delivery.id,
      status: delivery.status,
      attempts: delivery.attempts,
      maxAttempts: delivery.max_attempts,
      subject: delivery.subject,
      receivedAt: delivery.received_at,
      lastErrorCode: delivery.last_error_code,
      createdAt: delivery.created_at,
      completedAt: delivery.completed_at,
      manualRetryWarning: delivery.status === 'unknown_delivery'
    }))
  };
}

export function telegramFeatureError(config: ReturnType<typeof resolveTelegramConfig>) {
  if (!config.enabled) return { status: 409 as const, code: 'TELEGRAM_DISABLED', message: 'Telegram 通知尚未在此部署启用。' };
  if (!config.ready) return { status: 503 as const, code: 'TELEGRAM_NOT_READY', message: 'Telegram 运行时配置尚未完成。' };
  return null;
}
