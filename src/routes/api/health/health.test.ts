import { describe, expect, test } from 'bun:test';
import { GET } from './+server';

describe('/api/health liveness', () => {
  test('returns only minimal public liveness without reading runtime bindings', async () => {
    const response = await GET({
      request: new Request('https://mail.example.test/api/health', { headers: { 'X-Request-ID': 'health-test' } }),
      platform: undefined,
      locals: {}
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toBe('health-test');
    const payload = await response.json() as { ok?: boolean };
    expect(payload.ok).toBe(true);
  });
});
