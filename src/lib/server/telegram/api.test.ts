import { describe, expect, test } from 'bun:test';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { configureTelegramWebhook, sendTelegramMessage } from './api';

const env = {
  DB: {}, BUCKET: {}, APP_ENV: 'test', ALLOW_FAKE_SERVICES: 'true', OUTBOUND_PROVIDER: 'demo',
  TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
  TELEGRAM_WEBHOOK_SECRET: 'test-telegram-webhook-secret', TELEGRAM_BOT_USERNAME: 'flaremail_bot',
  APP_BASE_URL: 'http://127.0.0.1:8787'
} as unknown as CloudflareEnv;

describe('Telegram Bot API client', () => {
  test('identifies setup failure stage without exposing provider URLs', async () => {
    for (const stage of ['identity', 'webhook']) {
      let requests = 0;
      try {
        await configureTelegramWebhook(env, { fetchImpl: async () => {
          requests += 1;
          if (stage === 'webhook' && requests === 1) return Response.json({ ok: true, result: { id: 123, username: 'flaremail_bot' } });
          throw new TypeError(`Redirect rejected: https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`);
        } });
        throw new Error('Expected setup failure');
      } catch (error) {
        expect(error).toMatchObject({ code: `${stage}_redirect_rejected` });
        expect(JSON.stringify(error)).not.toContain(env.TELEGRAM_BOT_TOKEN!);
      }
    }
  });
  test('uses only the official HTTPS endpoint and Workers-compatible manual redirect policy', async () => {
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
    expect(request?.init?.redirect).toBe('manual');
  });

  test('rejects redirect responses at either setup stage without following or exposing secrets', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      for (const stage of ['identity', 'webhook']) {
        let requests = 0;
        await expect(configureTelegramWebhook(env, { fetchImpl: async (_input, init) => {
          expect(init?.redirect).toBe('manual');
          requests += 1;
          if (stage === 'webhook' && requests === 1) return Response.json({ ok: true, result: { id: 123, username: 'flaremail_bot' } });
          return new Response(null, { status, headers: { location: `https://untrusted.example/${env.TELEGRAM_BOT_TOKEN}` } });
        } })).rejects.toMatchObject({ code: `${stage}_redirect_rejected`, httpStatus: status });
        expect(requests).toBe(stage === 'identity' ? 1 : 2);
      }
    }
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

  test('checks the configured Bot and registers the exact webhook contract', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const result = await configureTelegramWebhook(env, {
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return requests.length === 1
          ? new Response(JSON.stringify({ ok: true, result: { id: 123, is_bot: true, first_name: 'FlareMail', username: 'flaremail_bot' } }), { status: 200 })
          : new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
    });

    expect(result).toEqual({ botId: '123', botUsername: 'flaremail_bot', webhookPath: '/api/webhooks/telegram' });
    expect(requests).toEqual([
      {
        url: 'https://api.telegram.org/bot123456:abcdefghijklmnopqrstuvwxyz/getMe',
        body: {}
      },
      {
        url: 'https://api.telegram.org/bot123456:abcdefghijklmnopqrstuvwxyz/setWebhook',
        body: {
          url: 'http://127.0.0.1:8787/api/webhooks/telegram',
          secret_token: 'test-telegram-webhook-secret',
          allowed_updates: ['message'],
          drop_pending_updates: false
        }
      }
    ]);
  });

  test('uses the derived webhook secret when no override is configured', async () => {
    const withoutOverride = { ...env };
    delete withoutOverride.TELEGRAM_WEBHOOK_SECRET;
    let webhookBody: Record<string, unknown> | undefined;
    await configureTelegramWebhook(withoutOverride, {
      fetchImpl: async (input, init) => {
        if (String(input).endsWith('/setWebhook')) webhookBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return String(input).endsWith('/getMe')
          ? new Response(JSON.stringify({ ok: true, result: { id: 123, is_bot: true, username: 'flaremail_bot' } }), { status: 200 })
          : new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
    });

    expect(webhookBody?.secret_token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  test('rejects a Bot identity that does not match the configured username', async () => {
    await expect(configureTelegramWebhook(env, {
      fetchImpl: async () => new Response(JSON.stringify({ ok: true, result: { id: 123, username: 'another_bot' } }), { status: 200 })
    })).rejects.toMatchObject({ kind: 'configuration', code: 'bot_username_mismatch' });
  });
});
