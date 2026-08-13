import { describe, expect, test } from 'bun:test';
import { normalizeResendWebhookEvent, ResendWebhookError, verifyResendWebhook } from './resend-webhook';

const secretRaw = new TextEncoder().encode('test webhook signing secret 1234');
const secret = `whsec_${btoa(String.fromCharCode(...secretRaw))}`;
const timestamp = 1_800_000_000;
const body = JSON.stringify({ type: 'email.delivered', created_at: '2027-01-15T08:00:00.000Z', data: { email_id: 're_123' } });

async function signature(id: string, value: string, time = timestamp) {
  const key = await crypto.subtle.importKey('raw', secretRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${time}.${value}`));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

async function signedHeaders(value = body, time = timestamp) {
  const id = 'msg_test_1';
  return new Headers({ 'svix-id': id, 'svix-timestamp': String(time), 'svix-signature': `v1,invalid v1,${await signature(id, value, time)}` });
}

describe('Resend webhook verification', () => {
  test('verifies the raw body and any matching v1 rotation signature', async () => {
    const result = await verifyResendWebhook(body, await signedHeaders(), secret, timestamp);
    expect(result.svixId).toBe('msg_test_1');
    expect(result.payload.type).toBe('email.delivered');
  });

  test('classifies missing, invalid, expired and bad signatures', async () => {
    await expect(verifyResendWebhook(body, new Headers(), secret, timestamp)).rejects.toMatchObject({ code: 'missing_headers' });
    const invalidTime = await signedHeaders(body, timestamp);
    invalidTime.set('svix-timestamp', 'not-a-time');
    await expect(verifyResendWebhook(body, invalidTime, secret, timestamp)).rejects.toMatchObject({ code: 'invalid_timestamp' });
    await expect(verifyResendWebhook(body, await signedHeaders(body, timestamp - 301), secret, timestamp)).rejects.toMatchObject({ code: 'expired' });
    const invalid = await signedHeaders();
    invalid.set('svix-signature', 'v1,invalid');
    await expect(verifyResendWebhook(body, invalid, secret, timestamp)).rejects.toMatchObject({ code: 'invalid_signature' });
  });

  test('verifies before returning typed JSON errors', async () => {
    const invalidJson = '{broken';
    await expect(verifyResendWebhook(invalidJson, await signedHeaders(invalidJson), secret, timestamp))
      .rejects.toMatchObject({ code: 'invalid_json' });
  });
});

describe('Resend event normalization', () => {
  test('maps delivery events without implying API delivery', () => {
    const cases = {
      'email.sent': 'sent', 'email.delivered': 'delivered', 'email.delivery_delayed': 'delayed',
      'email.bounced': 'bounced', 'email.failed': 'failed', 'email.complained': 'complained',
      'email.suppressed': 'suppressed', 'email.opened': null, 'email.clicked': null, 'email.future': null
    } as const;
    for (const [type, statusUpdate] of Object.entries(cases)) {
      const result = normalizeResendWebhookEvent({ type, created_at: '2027-01-15T08:00:00Z', data: { email_id: 're_123', to: ['private@example.test'], reason: 'private diagnostic' } });
      expect(result.statusUpdate).toBe(statusUpdate);
      expect(result.payloadJson).not.toContain('private@example.test');
      expect(result.payloadJson).not.toContain('private diagnostic');
      expect(result.summary).not.toContain('private@example.test');
    }
  });

  test('rejects missing provider identity or invalid dates', () => {
    expect(() => normalizeResendWebhookEvent({ type: 'email.sent', created_at: 'invalid', data: {} }))
      .toThrow(ResendWebhookError);
  });
});
