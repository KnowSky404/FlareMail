import type { CloudflareEnv } from '$lib/server/cloudflare';
import { validateEnvironment } from '$lib/server/config/env';
import { base64Url } from './utils';

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

const TELEGRAM_WEBHOOK_SECRET_CONTEXT = 'FlareMail Telegram webhook secret v1';

async function deriveTelegramWebhookSecret(botToken: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(botToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(TELEGRAM_WEBHOOK_SECRET_CONTEXT));
  return base64Url(new Uint8Array(signature));
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

/**
 * Telegram does not issue webhook secrets. It stores the value supplied to
 * setWebhook and echoes it in X-Telegram-Bot-Api-Secret-Token. Derive a
 * stable value from the Bot Token so the deployment needs only one secret.
 * An explicit TELEGRAM_WEBHOOK_SECRET remains an independent override.
 */
export async function resolveTelegramWebhookSecret(
  env?: CloudflareEnv,
  config: TelegramRuntimeConfig = resolveTelegramConfig(env)
) {
  if (!config.enabled || !config.botToken) return null;
  if (config.webhookSecret) return config.webhookSecret;

  return deriveTelegramWebhookSecret(config.botToken);
}

/** Resolve only the webhook-auth inputs, without probing D1/R2 bindings. */
export async function resolveTelegramWebhookSecretFromEnvironment(env?: CloudflareEnv) {
  const explicit = env?.TELEGRAM_WEBHOOK_SECRET?.trim() || null;
  if (explicit) return explicit;
  if (env?.TELEGRAM_ENABLED?.trim().toLowerCase() !== 'true') return null;
  const botToken = env?.TELEGRAM_BOT_TOKEN?.trim() || null;
  return botToken ? deriveTelegramWebhookSecret(botToken) : null;
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
