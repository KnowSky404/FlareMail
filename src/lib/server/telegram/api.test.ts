import { describe, expect, test } from 'bun:test';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { sendTelegramMessage } from './api';

const env = {
  DB: {}, BUCKET: {}, APP_ENV: 'test', ALLOW_FAKE_SERVICES: 'true', OUTBOUND_PROVIDER: 'demo',
  TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
  TELEGRAM_WEBHOOK_SECRET: 'test-telegram-webhook-secret', TELEGRAM_BOT_USERNAME: 'flaremail_bot',
  APP_BASE_URL: 'http://127.0.0.1:8787'
} as unknown as CloudflareEnv;

describe('Telegram Bot API client', () => {
  test('uses only the official HTTPS endpoint and redirect error policy', async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const result = await sendTelegramMessage(env, {
      chatId: '42', text: 'safe test', disableWebPagePreview: true
    }, {
      fetchImpl: async (input, init) => {
        request = { url: String(input), init };
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }
    });
    expect(result).toEqual({ messageId: '1' });
    expect(request?.url).toBe('https://api.telegram.org/bot123456:abcdefghijklmnopqrstuvwxyz/sendMessage');
    expect(request?.init?.redirect).toBe('error');
  });

  test('preserves retry_after as a typed rate-limit outcome', async () => {
    await expect(sendTelegramMessage(env, {
      chatId: '42', text: 'safe test', disableWebPagePreview: true
    }, {
      fetchImpl: async () => new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 17 } }), { status: 429 })
    })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 17 });
  });

  test('treats an unreadable provider response as unknown delivery', async () => {
    await expect(sendTelegramMessage(env, {
      chatId: '42', text: 'safe test', disableWebPagePreview: true
    }, {
      fetchImpl: async () => new Response('x'.repeat(32 * 1024 + 1), { status: 200 })
    })).rejects.toMatchObject({ kind: 'unknown', code: 'response_too_large' });

    await expect(sendTelegramMessage(env, {
      chatId: '42', text: 'safe test', disableWebPagePreview: true
    }, {
      fetchImpl: async () => new Response('{}', { status: 200 })
    })).rejects.toMatchObject({ kind: 'unknown', code: 'missing_error_code' });
  });
});
