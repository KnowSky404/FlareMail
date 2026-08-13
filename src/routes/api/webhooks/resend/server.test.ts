import { describe, expect, test } from 'bun:test';
import { ResendWebhookError } from '$lib/server/resend-webhook';
import { DeliveryPersistenceError } from '$lib/server/workspace/delivery';
import { _classifyWebhookProcessingError, POST } from './+server';

describe('Resend webhook route errors', () => {
  test('fails closed with 503 when the signing secret is absent', async () => {
    const response = await POST({
      request: new Request('https://mail.example.test/api/webhooks/resend', { method: 'POST', body: '{}' }),
      platform: { env: {} }
    } as never);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  test('returns 401 for an invalid signed request without exposing details', async () => {
    const response = await POST({
      request: new Request('https://mail.example.test/api/webhooks/resend', {
        method: 'POST', body: '{}', headers: {
          'svix-id': 'msg_1', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,invalid'
        }
      }),
      platform: { env: { RESEND_WEBHOOK_SECRET: `whsec_${btoa('test-secret-with-enough-entropy')}` } }
    } as never);
    expect(response.status).toBe(401);
    expect(await response.json() as unknown).toEqual({ ok: false, code: 'invalid_signature', error: 'Webhook verification failed.' });
  });

  test('returns 503 for a malformed signing secret', async () => {
    const response = await POST({
      request: new Request('https://mail.example.test/api/webhooks/resend', {
        method: 'POST', body: '{}', headers: {
          'svix-id': 'msg_1', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,invalid'
        }
      }),
      platform: { env: { RESEND_WEBHOOK_SECRET: 'whsec_bad' } }
    } as never);
    expect(response.status).toBe(503);
  });

  test('separates invalid payload, transient D1 failure and unexpected server errors', () => {
    expect(_classifyWebhookProcessingError(new ResendWebhookError('invalid_payload', 'private detail')).status).toBe(400);
    expect(_classifyWebhookProcessingError(new DeliveryPersistenceError('migration missing'))).toMatchObject({ status: 503, code: 'DELIVERY_PERSISTENCE_UNAVAILABLE' });
    expect(_classifyWebhookProcessingError(new Error('D1_ERROR: database unavailable'))).toMatchObject({ status: 503, code: 'WEBHOOK_STORAGE_UNAVAILABLE' });
    expect(_classifyWebhookProcessingError(new Error('unexpected invariant'))).toMatchObject({ status: 500, code: 'WEBHOOK_INTERNAL_ERROR' });
  });
});
