import { describe, expect, test } from 'bun:test';
import { resolveTelegramConfig } from './config';
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
  test('is ready only with enabled, credential-free origin and both secrets', () => {
    expect(resolveTelegramConfig(valid as unknown as CloudflareEnv).ready).toBe(true);
    expect(resolveTelegramConfig(valid as unknown as CloudflareEnv).botToken).not.toBeNull();
    expect(JSON.stringify(resolveTelegramConfig(valid as unknown as CloudflareEnv))).toContain('flaremail_bot');
    expect(JSON.stringify(validateEnvironment({ ...valid, TELEGRAM_BOT_TOKEN: 'not-a-token' })).toString()).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  test('rejects credentials, query strings, and insecure production origins', () => {
    expect(validateEnvironment({ ...valid, APP_BASE_URL: 'http://[::1]:8787' }).errors).toHaveLength(0);
    expect(validateEnvironment({ ...valid, APP_BASE_URL: 'https://user:password@mail.example.test' }).errors.map(({ code }) => code)).toContain('invalid_app_base_url');
    expect(validateEnvironment({ ...valid, APP_BASE_URL: 'http://127.0.0.1:8787', APP_ENV: 'production' }).errors.map(({ code }) => code)).toContain('invalid_app_base_url');
    expect(validateEnvironment({ ...valid, APP_BASE_URL: 'https://mail.example.test/path' }).errors.map(({ code }) => code)).toContain('invalid_app_base_url');
  });
});
