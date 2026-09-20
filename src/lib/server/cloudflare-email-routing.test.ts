import { describe, expect, test } from 'bun:test';
import {
  CloudflareEmailRoutingClient,
  CloudflareEmailRoutingError,
  isExactWorkerEmailRule
} from './cloudflare-email-routing';

const rule = (id: string, email: string, workerName = 'flaremail-worker') => ({
  id,
  name: 'FlareMail managed address address-1',
  enabled: true,
  source: 'api',
  matchers: [{ type: 'literal', field: 'to', value: email }],
  actions: [{ type: 'worker', value: [workerName] }]
});

const response = (result: unknown, resultInfo?: unknown) => new Response(JSON.stringify({
  success: true,
  result,
  ...(resultInfo ? { result_info: resultInfo } : {})
}), { status: 200, headers: { 'content-type': 'application/json' } });

describe('Cloudflare Email Routing API client', () => {
  test('uses the fixed API origin, a bearer token and a zone-scoped lookup', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new CloudflareEmailRoutingClient({
      token: 'routing-token-secret',
      fetcher: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return response({ id: 'zone-1', name: 'example.test', account: { id: 'account-1' } });
      }
    });
    expect(await client.getZone('zone-1')).toEqual({ id: 'zone-1', name: 'example.test', accountId: 'account-1' });
    expect(calls[0]?.url).toBe('https://api.cloudflare.com/client/v4/zones/zone-1');
    expect(calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer routing-token-secret' });
    expect(calls[0]?.url).not.toContain('routing-token-secret');
  });

  test('lists every page for only the explicitly configured zone', async () => {
    const calls: string[] = [];
    const client = new CloudflareEmailRoutingClient({
      token: 'test-token',
      fetcher: async (input) => {
        const url = String(input);
        calls.push(url);
        const page = new URL(url).searchParams.get('page');
        return page === '1'
          ? response([rule('rule-1', 'one@example.test')], { total_pages: 2 })
          : response([rule('rule-2', 'two@example.test')], { total_pages: 2 });
      }
    });
    expect((await client.listRules('zone-1')).map(({ id }) => id)).toEqual(['rule-1', 'rule-2']);
    expect(calls).toEqual([
      'https://api.cloudflare.com/client/v4/zones/zone-1/email/routing/rules?page=1&per_page=100',
      'https://api.cloudflare.com/client/v4/zones/zone-1/email/routing/rules?page=2&per_page=100'
    ]);
  });

  test('creates only literal/to routes to the configured Worker using API ownership', async () => {
    let requestBody: unknown = null;
    const client = new CloudflareEmailRoutingClient({
      token: 'test-token',
      fetcher: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response(rule('rule-created', 'sales@example.test'));
      }
    });
    const created = await client.createWorkerRule('zone-1', {
      email: 'sales@example.test',
      workerName: 'flaremail-worker',
      addressId: 'address-1'
    });
    expect(created.id).toBe('rule-created');
    expect(requestBody).toEqual({
      actions: [{ type: 'worker', value: ['flaremail-worker'] }],
      matchers: [{ type: 'literal', field: 'to', value: 'sales@example.test' }],
      enabled: true,
      name: 'FlareMail managed address address-1',
      source: 'api'
    });
  });

  test('classifies the exact active Worker rule and rejects unrelated targets', () => {
    const active = {
      id: 'rule-1', name: '', enabled: true, source: 'wrangler' as const,
      matchers: [{ type: 'literal', field: 'to', value: 'owner@example.test' }],
      actions: [{ type: 'worker', value: ['flaremail-worker'] }]
    };
    expect(isExactWorkerEmailRule(active, 'OWNER@example.test', 'flaremail-worker')).toBe(true);
    expect(isExactWorkerEmailRule({ ...active, actions: [{ type: 'worker', value: ['other-worker'] }] }, 'owner@example.test', 'flaremail-worker')).toBe(false);
    expect(isExactWorkerEmailRule({ ...active, enabled: false }, 'owner@example.test', 'flaremail-worker')).toBe(false);
  });

  test('surfaces only safe error categories for permission, throttling and timeout failures', async () => {
    for (const [status, code] of [[403, 'permission_denied'], [429, 'rate_limited']] as const) {
      const client = new CloudflareEmailRoutingClient({
        token: 'secret-token',
        fetcher: async () => new Response('{"success":false,"errors":[{"message":"private detail"}]}', { status })
      });
      await expect(client.listRules('zone-1')).rejects.toMatchObject({ code });
    }
    const timedOut = new CloudflareEmailRoutingClient({
      token: 'secret-token',
      fetcher: async () => { throw new DOMException('secret transport detail', 'AbortError'); }
    });
    await expect(timedOut.createWorkerRule('zone-1', {
      email: 'owner@example.test', workerName: 'flaremail-worker', addressId: 'address-1'
    })).rejects.toMatchObject({ code: 'timeout', retryable: true });
    const error = new CloudflareEmailRoutingError('permission_denied', 403);
    expect(error.message).toBe('permission_denied');
    expect(error.message).not.toContain('secret-token');
  });
});
