import { describe, expect, test } from 'bun:test';
import { ApiError, apiFailure, apiSuccess, getRequestId } from './api';

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
});
