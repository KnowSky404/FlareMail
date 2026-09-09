import type { CloudflareEnv } from '$lib/server/cloudflare';
import { validateEnvironment } from '$lib/server/config/env';

export interface TelegramRuntimeConfig {
  enabled: boolean;
  ready: boolean;
  botToken: string | null;
  webhookSecret: string | null;
  botUsername: string | null;
  appBaseUrl: string | null;
  timeoutMs: number;
}

function timeoutMs(value: string | undefined) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1_000 && parsed <= 15_000 ? parsed : 5_000;
}

export function resolveTelegramConfig(env?: CloudflareEnv): TelegramRuntimeConfig {
  const validation = validateEnvironment((env ?? {}) as unknown as Record<string, unknown>);
  const config = validation.config;
  const enabled = config.telegramEnabled;
  return {
    enabled,
    ready: enabled && config.telegramConfigured && validation.errors.every(({ code }) => !code.startsWith('telegram_') && code !== 'missing_app_base_url' && code !== 'invalid_app_base_url'),
    botToken: enabled ? env?.TELEGRAM_BOT_TOKEN?.trim() || null : null,
    webhookSecret: enabled ? env?.TELEGRAM_WEBHOOK_SECRET?.trim() || null : null,
    botUsername: enabled ? config.telegramBotUsername : null,
    appBaseUrl: enabled ? config.appBaseUrl : null,
    timeoutMs: timeoutMs(env?.TELEGRAM_TIMEOUT_MS)
  };
}

export function telegramConfigurationSummary(env?: CloudflareEnv) {
  const resolved = resolveTelegramConfig(env);
  return {
    enabled: resolved.enabled,
    configured: resolved.ready,
    botUsername: resolved.botUsername,
    appBaseUrlConfigured: Boolean(resolved.appBaseUrl)
  };
}
