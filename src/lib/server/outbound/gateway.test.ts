import { describe, expect, test } from 'bun:test';
import {
  FakeOutboundGateway,
  OutboundGatewayError,
  ResendOutboundGateway,
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  MAX_OUTBOUND_ATTACHMENT_COUNT,
  MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES,
  MAX_RESEND_RESPONSE_BYTES,
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
  test('rejects non-HTTPS or credential-bearing provider endpoints', () => {
    expect(() => new ResendOutboundGateway({ apiKey: 're_test_secret', apiBaseUrl: 'http://resend.test' }))
      .toThrow(OutboundGatewayError);
    expect(() => new ResendOutboundGateway({ apiKey: 're_test_secret', apiBaseUrl: 'https://user:pass@resend.test' }))
      .toThrow(OutboundGatewayError);
  });

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

  test('serializes owned bytes as Base64 attachments and preserves recipient arrays and idempotency', async () => {
    let request: RequestInit | undefined;
    const gateway = new ResendOutboundGateway({
      apiKey: 're_test_secret',
      fetch: async (_url, init) => { request = init; return jsonResponse({ id: 're_attachment' }); }
    });
    await gateway.send(input({
      to: ['to@example.net'], cc: ['cc@example.net'], bcc: ['bcc@example.net'],
      attachments: [
        { filename: '../你好.txt', bytes: new TextEncoder().encode('hello'), contentType: 'Text/Plain' },
        { filename: 'logo.png', bytes: new Uint8Array([0, 1, 255]), contentType: 'image/png', contentId: 'logo-cid', disposition: 'inline' }
      ]
    }));
    expect(new Headers(request?.headers).get('Idempotency-Key')).toBe('delivery:message-123');
    expect(JSON.parse(String(request?.body))).toMatchObject({
      to: ['to@example.net'], cc: ['cc@example.net'], bcc: ['bcc@example.net'],
      attachments: [
        { filename: '你好.txt', content: 'aGVsbG8=', content_type: 'text/plain' },
        { filename: 'logo.png', content: 'AAH/', content_type: 'image/png', content_id: 'logo-cid' }
      ]
    });
  });

  test('rejects attachment limits and malformed metadata before provider fetch', async () => {
    let calls = 0;
    const gateway = new ResendOutboundGateway({ apiKey: 're_test_secret', fetch: async () => { calls += 1; return jsonResponse({ id: 'unexpected' }); } });
    const cases: OutboundMailInput[] = [
      input({ attachments: Array.from({ length: MAX_OUTBOUND_ATTACHMENT_COUNT + 1 }, (_, i) => ({ filename: `${i}.bin`, bytes: new Uint8Array() })) }),
      input({ attachments: [{ filename: 'large.bin', bytes: new Uint8Array(MAX_OUTBOUND_ATTACHMENT_BYTES + 1) }] }),
      input({ attachments: [{ filename: 'total.bin', bytes: new Uint8Array(MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES + 1) }] }),
      input({ attachments: [{ filename: 'bad\r\nname.txt', bytes: new Uint8Array([1]), contentType: 'not-a-mime' }] }),
      input({ attachments: [{ filename: 'ok.txt', bytes: new Uint8Array([1]), contentId: 'bad\ncontent-id' }] }),
      input({ attachments: [{ filename: '你'.repeat(100), bytes: new Uint8Array([1]) }] }),
      input({ attachments: [{ filename: 'inline.png', bytes: new Uint8Array([1]), disposition: 'inline' }] })
    ];
    for (const candidate of cases) await expect(gateway.send(candidate)).rejects.toMatchObject({ kind: 'configuration' });
    expect(calls).toBe(0);
  });

  test('rejects malformed sender, recipients, and bounded header fields before provider fetch', async () => {
    let calls = 0;
    const gateway = new ResendOutboundGateway({
      apiKey: 're_test_secret',
      fetch: async () => { calls += 1; return jsonResponse({ id: 'unexpected' }); }
    });
    const cases: OutboundMailInput[] = [
      input({ from: 'not-an-email' }),
      input({ from: 'Sender\n <sender@example.com>' }),
      input({ to: ['invalid-recipient'] }),
      input({ to: ['recipient@example.net\u0000'] }),
      input({ to: Array.from({ length: 51 }, (_, index) => `recipient-${index}@example.net`) }),
      input({ subject: `主题${'界'.repeat(400)}` }),
      input({ subject: `x${'a'.repeat(998)}` }),
      input({ subject: 'Hello\r\nBcc: attacker@example.net' })
    ];
    for (const candidate of cases) await expect(gateway.send(candidate)).rejects.toMatchObject({ kind: 'configuration' });
    expect(calls).toBe(0);
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

  test('bounds provider response reads and cancels an oversized stream', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(MAX_RESEND_RESPONSE_BYTES + 1)));
      },
      cancel() { cancelled = true; }
    });
    const gateway = new ResendOutboundGateway({
      apiKey: 're_test_secret',
      fetch: async () => ({
        status: 502,
        body,
        text: async () => { throw new Error('unbounded response.text() must not be called'); }
      } as unknown as Response)
    });
    await expect(gateway.send(input())).rejects.toMatchObject({
      kind: 'server_error',
      remoteStatus: 502,
      responsePreview: 'Resend returned HTTP 502.'
    });
    expect(cancelled).toBe(true);
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

  test('records an independent safe copy of attachment bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const gateway = new FakeOutboundGateway();
    await gateway.send(input({ attachments: [{ filename: 'a.bin', bytes }] }));
    bytes[0] = 9;
    expect(gateway.sent[0]?.attachments?.[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('can inject a typed failure for retry tests', async () => {
    const error = new OutboundGatewayError('network_unknown', 'unknown outcome');
    const gateway = new FakeOutboundGateway({ error });
    await expect(gateway.send(input())).rejects.toBe(error);
  });

  test('derives a stable provider id from the durable idempotency key', async () => {
    const gateway = new FakeOutboundGateway();
    const first = await gateway.send(input({ idempotencyKey: 'outbound:message-1' }));
    const second = await gateway.send(input({ idempotencyKey: 'outbound:message-1' }));
    expect(first.providerMessageId).toBe('fake-outbound:message-1');
    expect(second.providerMessageId).toBe(first.providerMessageId);
  });
});
