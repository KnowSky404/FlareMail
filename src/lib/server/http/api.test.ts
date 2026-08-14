import { describe, expect, test } from 'bun:test';
import { ApiError, apiFailure, apiSuccess, getRequestId, readJsonBody } from './api';

const event = (requestId?: string) => ({
  request: new Request('https://mail.example.test/api/test', {
    headers: requestId ? { 'X-Request-ID': requestId } : undefined
  })
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
