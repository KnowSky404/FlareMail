import { describe, expect, test } from 'bun:test';
import {
  FakeOutboundGateway,
  OutboundGatewayError,
  ResendOutboundGateway,
  type OutboundMailInput
} from './gateway';

const input = (overrides: Partial<OutboundMailInput> = {}): OutboundMailInput => ({
  idempotencyKey: 'delivery:message-123',
  from: 'FlareMail <sender@example.com>',
  to: ['recipient@example.net'],
  subject: 'Hello',
  text: 'Plain body',
  ...overrides
});

const jsonResponse = (body: unknown, status = 202) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ResendOutboundGateway', () => {
  test('serializes the REST payload with snake_case reply_to and optional fields', async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const gateway = new ResendOutboundGateway({
      apiKey: 're_test_secret',
      apiBaseUrl: 'https://resend.test/',
      fetch: async (url, init) => {
        request = { url: String(url), init: init as RequestInit };
        return jsonResponse({ id: 're_123' });
      }
    });

    const result = await gateway.send(
      input({
        cc: ['copy@example.net'],
        bcc: ['blind@example.net'],
        html: '<p>HTML body</p>',
        replyTo: ['reply@example.com'],
        headers: { 'X-Thread-Id': '<thread@example.com>' },
        tags: [{ name: 'environment', value: 'test' }]
      })
    );

    expect(result).toEqual({ status: 'submitted', providerMessageId: 're_123', remoteStatus: 202 });
    expect(request?.url).toBe('https://resend.test/emails');
    expect(request?.init.method).toBe('POST');
    expect(new Headers(request?.init.headers).get('Idempotency-Key')).toBe('delivery:message-123');
    expect(JSON.parse(String(request?.init.body))).toEqual({
      from: 'FlareMail <sender@example.com>',
      to: ['recipient@example.net'],
      cc: ['copy@example.net'],
      bcc: ['blind@example.net'],
      subject: 'Hello',
      text: 'Plain body',
      html: '<p>HTML body</p>',
      reply_to: ['reply@example.com'],
      headers: { 'X-Thread-Id': '<thread@example.com>' },
      tags: [{ name: 'environment', value: 'test' }]
    });
  });

  test('requires a stable idempotency key and reuses it on retries', async () => {
    const keys: string[] = [];
    const gateway = new ResendOutboundGateway({
      apiKey: 're_test_secret',
      fetch: async (_url, init) => {
        keys.push(new Headers(init?.headers).get('Idempotency-Key') ?? '');
        return jsonResponse({ id: `re_${keys.length}` });
      }
    });

    await gateway.send(input());
    await gateway.send(input());
    expect(keys).toEqual(['delivery:message-123', 'delivery:message-123']);
    await expect(gateway.send(input({ idempotencyKey: 'x'.repeat(257) }))).rejects.toMatchObject({ kind: 'configuration' });
  });

  test('classifies 409 payload mismatch separately from concurrent requests', async () => {
    const mismatch = new ResendOutboundGateway({
      apiKey: 're_test_secret',
      fetch: async () => jsonResponse({ message: 'Idempotency key payload mismatch' }, 409)
    });
    const concurrent = new ResendOutboundGateway({
      apiKey: 're_test_secret',
      fetch: async () => jsonResponse({ message: 'Request is currently being processed' }, 409)
    });

    await expect(mismatch.send(input())).rejects.toMatchObject({ kind: 'idempotency_conflict', retryable: false, remoteStatus: 409 });
    await expect(concurrent.send(input())).rejects.toMatchObject({ kind: 'concurrent', retryable: true, remoteStatus: 409 });
  });

  test('classifies rate limits, client errors, server errors, and non-JSON responses', async () => {
    for (const [status, kind, retryable] of [
      [429, 'rate_limited', true],
      [400, 'client_error', false],
      [503, 'server_error', true]
    ] as const) {
      const gateway = new ResendOutboundGateway({
        apiKey: 're_test_secret',
        fetch: async () => new Response('provider failure', { status })
      });
      await expect(gateway.send(input())).rejects.toMatchObject({ kind, retryable, remoteStatus: status });
    }
  });

  test('distinguishes timeout from an unknown network outcome', async () => {
    const timeoutGateway = new ResendOutboundGateway({
      apiKey: 're_test_secret',
      timeoutMs: 5,
      fetch: async (_url, init) =>
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        })
    });
    await expect(timeoutGateway.send(input())).rejects.toMatchObject({ kind: 'timeout', retryable: true });

    const networkGateway = new ResendOutboundGateway({
      apiKey: 're_test_secret',
      fetch: async () => {
        throw new Error('socket closed');
      }
    });
    await expect(networkGateway.send(input())).rejects.toMatchObject({ kind: 'network_unknown', retryable: true });
  });

  test('forwards an already-aborted caller signal without misclassifying it as a timeout', async () => {
    const controller = new AbortController();
    controller.abort('caller cancelled');
    const gateway = new ResendOutboundGateway({
      apiKey: 're_test_secret',
      fetch: async (_url, init) => {
        expect(init?.signal?.aborted).toBe(true);
        throw Object.assign(new Error('aborted by caller'), { name: 'AbortError' });
      }
    });
    await expect(gateway.send(input(), { signal: controller.signal })).rejects.toMatchObject({ kind: 'network_unknown' });
  });

  test('rejects a successful response without a provider message id', async () => {
    const gateway = new ResendOutboundGateway({ apiKey: 're_test_secret', fetch: async () => jsonResponse({ ok: true }) });
    await expect(gateway.send(input())).rejects.toMatchObject({ kind: 'invalid_response', remoteStatus: 202 });
  });

  test('does not attempt network access without an API key', async () => {
    let calls = 0;
    const gateway = new ResendOutboundGateway({ fetch: async () => { calls += 1; return jsonResponse({ id: 'never' }); } });
    await expect(gateway.send(input())).rejects.toMatchObject({ kind: 'configuration', retryable: false });
    expect(calls).toBe(0);
  });

  test('does not copy non-JSON provider bodies into the error summary', async () => {
    const gateway = new ResendOutboundGateway({
      apiKey: 're_test_secret',
      fetch: async () => new Response('request body leaked: sender@example.com', { status: 502 })
    });
    let failure: OutboundGatewayError | undefined;
    try {
      await gateway.send(input());
    } catch (error) {
      failure = error as OutboundGatewayError;
    }
    expect(failure).toBeDefined();
    expect(failure?.kind).toBe('server_error');
    expect(failure?.message).not.toContain('request body leaked');
    expect(failure?.message).not.toContain('sender@example.com');
  });

  test('does not persist JSON provider error text as the public summary', async () => {
    const gateway = new ResendOutboundGateway({
      apiKey: 're_test_secret',
      fetch: async () => jsonResponse({ message: 'recipient sender@example.com was rejected' }, 400)
    });
    await expect(gateway.send(input())).rejects.toMatchObject({
      kind: 'client_error',
      message: 'Resend returned HTTP 400.',
      responsePreview: 'Resend returned HTTP 400.'
    });
  });
});

describe('FakeOutboundGateway', () => {
  test('is explicit, deterministic, and records the original request without network access', async () => {
    const gateway = new FakeOutboundGateway({ providerMessageId: 'fake-fixed' });
    const result = await gateway.send(input({ replyTo: ['reply@example.com'] }));
    expect(result).toEqual({ status: 'submitted', providerMessageId: 'fake-fixed', remoteStatus: 202 });
    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]?.replyTo).toEqual(['reply@example.com']);
  });

  test('can inject a typed failure for retry tests', async () => {
    const error = new OutboundGatewayError('network_unknown', 'unknown outcome');
    const gateway = new FakeOutboundGateway({ error });
    await expect(gateway.send(input())).rejects.toBe(error);
  });
});
