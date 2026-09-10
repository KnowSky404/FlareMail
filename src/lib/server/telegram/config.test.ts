import { describe, expect, test } from 'bun:test';
import { resolveTelegramConfig, resolveTelegramWebhookSecret } from './config';
import { validateEnvironment } from '$lib/server/config/env';
import type { CloudflareEnv } from '$lib/server/cloudflare';

const valid = {
  APP_ENV: 'test',
  ALLOW_FAKE_SERVICES: 'true',
  OUTBOUND_PROVIDER: 'demo',
  DB: {},
  BUCKET: {},
  TELEGRAM_ENABLED: 'true',
  TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
  TELEGRAM_WEBHOOK_SECRET: 'test-telegram-webhook-secret',
  TELEGRAM_BOT_USERNAME: 'flaremail_bot',
  APP_BASE_URL: 'http://127.0.0.1:8787'
};

describe('Telegram runtime configuration', () => {
  test('is ready with the Bot Token and enabled, credential-free origin', () => {
    expect(resolveTelegramConfig(valid as unknown as CloudflareEnv).ready).toBe(true);
    expect(resolveTelegramConfig(valid as unknown as CloudflareEnv).botToken).not.toBeNull();
    expect(JSON.stringify(resolveTelegramConfig(valid as unknown as CloudflareEnv))).toContain('flaremail_bot');
    expect(JSON.stringify(validateEnvironment({ ...valid, TELEGRAM_BOT_TOKEN: 'not-a-token' })).toString()).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  test('derives a stable webhook secret when no override is configured', async () => {
    const withoutOverride: Record<string, unknown> = { ...valid };
    delete withoutOverride.TELEGRAM_WEBHOOK_SECRET;
    const config = resolveTelegramConfig(withoutOverride as unknown as CloudflareEnv);
    const first = await resolveTelegramWebhookSecret(withoutOverride as unknown as CloudflareEnv, config);
    const second = await resolveTelegramWebhookSecret(withoutOverride as unknown as CloudflareEnv, config);

    expect(config.ready).toBe(true);
    expect(config.webhookSecret).toBeNull();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first).toBe(second);
    expect(first).not.toBe(valid.TELEGRAM_WEBHOOK_SECRET);
  });

  test('rejects an explicit webhook override outside Telegram token characters', () => {
    expect(validateEnvironment({ ...valid, TELEGRAM_WEBHOOK_SECRET: 'invalid webhook secret' }).errors.map(({ code }) => code))
      .toContain('invalid_telegram_webhook_secret');
  });

  test('rejects credentials, query strings, and insecure production origins', () => {
    expect(validateEnvironment({ ...valid, APP_BASE_URL: 'http://[::1]:8787' }).errors).toHaveLength(0);
    expect(validateEnvironment({ ...valid, APP_BASE_URL: 'https://user:password@mail.example.test' }).errors.map(({ code }) => code)).toContain('invalid_app_base_url');
    expect(validateEnvironment({ ...valid, APP_BASE_URL: 'http://127.0.0.1:8787', APP_ENV: 'production' }).errors.map(({ code }) => code)).toContain('invalid_app_base_url');
    expect(validateEnvironment({ ...valid, APP_BASE_URL: 'https://mail.example.test/path' }).errors.map(({ code }) => code)).toContain('invalid_app_base_url');
  });
});
