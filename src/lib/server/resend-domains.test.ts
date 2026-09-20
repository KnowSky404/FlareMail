import { describe, expect, test } from 'bun:test';
import { canSendFromResendDomain, getExactResendDomain } from './resend-domains';

const domain = (name: string, status: string, sending: string) => ({
  id: 'domain-1',
  name,
  status,
  capabilities: { sending, receiving: 'disabled' }
});

const list = (data: unknown[], hasMore = false) => new Response(JSON.stringify({ object: 'list', data, has_more: hasMore }), {
  status: 200,
  headers: { 'content-type': 'application/json' }
});

describe('Resend sending domain verification', () => {
  test('requires the exact From domain, verified status and enabled sending capability', async () => {
    let calls = 0;
    const checked = await getExactResendDomain('secret-key', 'sub.example.test', {
      fetcher: async () => {
        calls += 1;
        return list([domain('example.test', 'verified', 'enabled'), domain('sub.example.test', 'verified', 'enabled')]);
      }
    });
    expect(calls).toBe(1);
    expect(checked?.id).toBe('domain-1');
    expect(canSendFromResendDomain(checked, 'sub.example.test')).toBe(true);
    expect(canSendFromResendDomain(checked, 'example.test')).toBe(false);
  });

  test('does not treat pending, partial, failed or sending-disabled domains as verified', async () => {
    for (const value of [
      domain('example.test', 'pending', 'enabled'),
      domain('example.test', 'partially_verified', 'enabled'),
      domain('example.test', 'verified', 'disabled')
    ]) {
      const checked = await getExactResendDomain('secret-key', 'example.test', {
        fetcher: async () => list([value])
      });
      expect(canSendFromResendDomain(checked, 'example.test')).toBe(false);
    }
  });

  test('follows Resend pagination and returns no inferred parent-domain permission', async () => {
    const urls: string[] = [];
    const checked = await getExactResendDomain('secret-key', 'mail.sub.example.test', {
      fetcher: async (input) => {
        const url = String(input);
        urls.push(url);
        return urls.length === 1
          ? list([domain('example.test', 'verified', 'enabled')], true)
          : list([domain('sub.example.test', 'verified', 'enabled')]);
      }
    });
    expect(urls[0]).toBe('https://api.resend.com/domains?limit=100');
    expect(urls[1]).toContain('after=domain-1');
    expect(checked).toBeNull();
  });

  test('redacts provider details and returns safe categories', async () => {
    const client = getExactResendDomain('secret-key', 'example.test', {
      fetcher: async () => new Response('{"error":"private details"}', { status: 403 })
    });
    await expect(client).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(getExactResendDomain('', 'example.test')).rejects.toMatchObject({ code: 'api_key_missing' });
  });
});
