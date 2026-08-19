import { describe, expect, test } from 'bun:test';
import { ApiError, apiFailure, apiSuccess, getRequestId, readJsonBody, withApiHandler } from './api';

const event = (requestId?: string) => ({
  request: new Request('https://mail.example.test/api/test', {
    headers: requestId ? { 'X-Request-ID': requestId } : undefined
  }),
  url: new URL('https://mail.example.test/api/test'),
  locals: {}
}) as never;

describe('API response envelope', () => {
  test('echoes a safe request id in success responses', async () => {
    const response = apiSuccess(event('client-123'), { value: 1 });
    expect(response.headers.get('x-request-id')).toBe('client-123');
    expect(await response.json() as unknown).toEqual({
      ok: true,
      data: { value: 1 },
      requestId: 'client-123'
    });
  });

  test('normalizes typed failures without leaking implementation details', async () => {
    const response = apiFailure(
      event('request-9'),
      new ApiError(400, 'VALIDATION_FAILED', '字段无效。', { query: ['查询过长。'] })
    );
    expect(response.status).toBe(400);
    expect(await response.json() as unknown).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: '字段无效。',
        fieldErrors: { query: ['查询过长。'] }
      },
      requestId: 'request-9'
    });
  });

  test('rejects unsafe correlation ids', () => {
    expect(getRequestId(event('bad id with spaces'))).not.toBe('bad id with spaces');
  });

  test('reuses one request id through locals and every response header', async () => {
    const current = event('stable-request');
    expect(getRequestId(current)).toBe('stable-request');
    expect(getRequestId(current)).toBe('stable-request');
    expect(apiSuccess(current, { ok: true }).headers.get('x-request-id')).toBe('stable-request');
    expect(apiFailure(current, new ApiError(503, 'D1_UNAVAILABLE', '暂不可用。')).headers.get('x-request-id')).toBe('stable-request');
  });

  test('exposes only explicitly safe error details', async () => {
    const response = apiFailure(event('safe-details'), new ApiError(
      409,
      'DELIVERY_REVIEW_REQUIRED',
      '需要人工检查。',
      undefined,
      { reason: 'idempotency_window_expired', reviewRequired: true, providerWindowHours: 24,
        draftId: 'draft-1', updatedAt: '2026-08-19T12:00:00.000Z', draft: { body: 'private body' }, secret: 'private' }
    ));
    expect(await response.json() as unknown).toEqual({
      ok: false,
      error: {
        code: 'DELIVERY_REVIEW_REQUIRED',
        message: '需要人工检查。',
        details: { reason: 'idempotency_window_expired', reviewRequired: true, providerWindowHours: 24,
          draftId: 'draft-1', updatedAt: '2026-08-19T12:00:00.000Z' }
      },
      requestId: 'safe-details'
    });
  });

  test('maps unknown, schema and storage failures to typed safe envelopes', async () => {
    for (const [error, expectedCode, expectedStatus] of [
      [new Error('no such table: workspace_messages'), 'SCHEMA_NOT_READY', 503],
      [new Error('D1 database unavailable'), 'D1_UNAVAILABLE', 503],
      [new Error('private invariant stack trace'), 'INTERNAL_ERROR', 500]
    ] as const) {
      const response = await withApiHandler(async () => { throw error; })(event(`failure-${expectedCode}`));
      expect(response.status).toBe(expectedStatus);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toEqual(expect.objectContaining({ requestId: `failure-${expectedCode}` }));
      expect(body).toEqual(expect.objectContaining({ error: expect.objectContaining({ code: expectedCode }) }));
      expect(JSON.stringify(body)).not.toContain('private invariant stack trace');
    }
  });

  test('bounds JSON by media type, declared length and observed bytes', async () => {
    const validEvent = (request: Request) => ({ request }) as never;
    await expect(readJsonBody(validEvent(new Request('https://mail.example.test', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}'
    })))).rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
    await expect(readJsonBody(validEvent(new Request('https://mail.example.test', {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '999' }, body: '{}'
    })), { maxBytes: 10 })).rejects.toMatchObject({ status: 413, code: 'JSON_BODY_TOO_LARGE' });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"12345'));
        controller.enqueue(new TextEncoder().encode('67890"}'));
        controller.close();
      }
    });
    await expect(readJsonBody(validEvent(new Request('https://mail.example.test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: stream
    })), { maxBytes: 10 })).rejects.toMatchObject({ status: 413, code: 'JSON_BODY_TOO_LARGE' });
    await expect(readJsonBody(validEvent(new Request('https://mail.example.test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{'
    })))).rejects.toMatchObject({ status: 400, code: 'INVALID_JSON' });
    await expect(readJsonBody(validEvent(new Request('https://mail.example.test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ok":true}'
    })))).resolves.toEqual({ ok: true });
  });
});
