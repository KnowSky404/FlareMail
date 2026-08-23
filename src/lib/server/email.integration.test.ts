import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, spyOn, test } from 'bun:test';
import { createInboundDedupeKey, handleInboundEmail } from './email';

class TestStatement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly database: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.database.query(this.sql).get(...this.values) as T | null) ?? null; }
  async all<T>() { return { success: true, results: this.database.query(this.sql).all(...this.values) as T[] }; }
  async run<T>() { this.database.query(this.sql).run(...this.values); return { success: true, results: [] as T[] }; }
}

class TestD1 {
  failBatch = false;
  failClaimCompletion = false;
  constructor(readonly database: Database) {}
  prepare(sql: string) {
    if (this.failClaimCompletion && sql.includes("UPDATE workspace_inbound_ingest_claims SET status = 'completed'")) {
      return { bind: () => ({ run: async () => { throw new Error('simulated claim finalize failure'); } }) } as unknown as D1PreparedStatement;
    }
    return new TestStatement(this.database, sql) as unknown as D1PreparedStatement;
  }
  async batch(statements: D1PreparedStatement[]) {
    if (this.failBatch) throw new Error('simulated d1 write failure');
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

class TestBucket {
  readonly objects = new Map<string, Uint8Array>();
  readonly metadata = new Map<string, Record<string, string>>();
  readonly checksums = new Map<string, string>();
  putCount = 0;
  getCount = 0;
  failPuts = false;
  failGets = false;
  failDeletes = false;
  async put(key: string, value: ArrayBuffer | Uint8Array, options?: R2PutOptions) {
    if (this.failPuts) throw new Error('simulated r2 write failure');
    this.putCount += 1;
    this.objects.set(key, value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value.slice(0)));
    this.metadata.set(key, options?.customMetadata ?? {});
    if (typeof options?.sha256 === 'string') this.checksums.set(key, options.sha256);
    return {} as R2Object;
  }
  async get(key: string) {
    this.getCount += 1;
    if (this.failGets) throw new Error('simulated r2 read failure');
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const response = new Response(bytes.buffer as ArrayBuffer);
    return { body: response.body, size: bytes.byteLength, arrayBuffer: () => bytes.slice().buffer,
      httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: this.metadata.get(key) ?? {} } as unknown as R2Object;
  }
  async delete(key: string) {
    if (this.failDeletes) throw new Error('simulated r2 delete failure');
    this.objects.delete(key);
    this.metadata.delete(key);
    this.checksums.delete(key);
  }
}

const fixtureBytes = (name = 'base64-attachment') => {
  const bytes = readFileSync(new URL(`../../../tests/fixtures/eml/${name}.eml`, import.meta.url));
  return new Uint8Array(bytes);
};

type Barrier = { wait: () => Promise<void> };

const barrier = (count: number): Barrier => {
  let arrivals = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  return {
    wait: async () => {
      arrivals += 1;
      if (arrivals >= count) release();
      await released;
    }
  };
};

const message = (bytes = fixtureBytes(), to = 'owner@example.test', declaredSize = bytes.byteLength, gate?: Barrier) => {
  let rejected = '';
  const value = {
    from: 'alice@example.com',
    to,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          await gate?.wait();
          controller.enqueue(bytes);
          controller.close();
        })();
      }
    }),
    rawSize: declaredSize,
    headers: new Headers(),
    setReject(reason: string) { rejected = reason; }
  } as unknown as ForwardableEmailMessage;
  return { value, rejected: () => rejected };
};

const environment = (failBatch = false) => {
  const database = new Database(':memory:');
  database.exec(readFileSync(new URL('../../../schema.sql', import.meta.url), 'utf8'));
  database.query(`
    INSERT INTO workspace_users (
      id, login_email, name, role, email, company, location, timezone,
      forwarding_enabled, signature, incoming_sequence
    ) VALUES ('user-1', 'owner@example.test', 'Owner', 'Owner', 'owner@example.test', '', '', 'UTC', 0, '', 0)
  `).run();
  const DB = new TestD1(database);
  DB.failBatch = failBatch;
  const BUCKET = new TestBucket();
  return { database, DB, BUCKET, env: { DB, BUCKET, OUTBOUND_PROVIDER: 'demo' } as unknown as import('./cloudflare').CloudflareEnv };
};

const captureResend = async <T>(action: () => Promise<T>) => {
  const previousFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = (async (_input, init) => {
    requests.push(init ?? {});
    return new Response(JSON.stringify({ id: 're_notification' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  try {
    return { requests, result: await action() };
  } finally {
    globalThis.fetch = previousFetch;
  }
};

const notificationEnvironment = () => {
  const test = environment();
  test.env = {
    ...test.env,
    APP_ENV: 'test',
    OUTBOUND_PROVIDER: 'resend',
    RESEND_API_KEY: 'test-key',
    OUTBOUND_FROM_EMAIL: 'mail@example.test',
    INBOUND_NOTIFICATION_ENABLED: 'true',
    NOTIFICATION_EMAIL: 'ops@example.test'
  } as unknown as import('./cloudflare').CloudflareEnv;
  return test;
};

describe('inbound email persistence', () => {
  test('stores large UTF-8 text/html in a canonical R2 body and bounded D1 projections', async () => {
    const test = environment();
    const boundary = 'body-boundary';
    const raw = new TextEncoder().encode([
      'From: alice@example.com', 'To: owner@example.test', 'Subject: Large body',
      `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', '正文😀'.repeat(70_000),
      `--${boundary}`, 'Content-Type: text/html; charset=utf-8', '', `<p>${'内容中文'.repeat(40_000)}</p>`,
      `--${boundary}--`, ''
    ].join('\r\n'));
    await handleInboundEmail(message(raw).value, test.env);
    const row = test.database.query('SELECT body_object_id, length(text_body) AS text_length, length(html_body) AS html_length FROM email_messages').get() as { body_object_id: string | null; text_length: number; html_length: number };
    expect(row.body_object_id).toBeString();
    const projection = test.database.query('SELECT text_body, html_body FROM email_messages').get() as { text_body: string; html_body: string };
    expect(new TextEncoder().encode(projection.text_body).byteLength).toBeLessThanOrEqual(128 * 1024);
    expect(new TextEncoder().encode(projection.html_body).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(test.BUCKET.objects.size).toBe(2);
    expect(test.database.query('SELECT COUNT(*) AS count FROM mail_body_objects').get()).toEqual({ count: 1 });
  });

  test('keeps the D1 body columns bounded when no canonical body object is written', async () => {
    const test = environment();
    const raw = new TextEncoder().encode([
      'From: alice@example.com', 'To: owner@example.test', 'Subject: Inline body',
      'Content-Type: text/plain; charset=utf-8', '', 'x'.repeat(200 * 1024), ''
    ].join('\r\n'));
    await handleInboundEmail(message(raw).value, test.env);
    const row = test.database.query('SELECT body_object_id, text_body FROM email_messages').get() as { body_object_id: string | null; text_body: string };
    expect(row.body_object_id).toBeNull();
    expect(new TextEncoder().encode(row.text_body).byteLength).toBeLessThanOrEqual(128 * 1024);
    expect(test.BUCKET.objects.size).toBe(1);
  });

  test('stores raw, parsed metadata and attachment exactly once', async () => {
    const test = environment();
    const first = message();
    await handleInboundEmail(first.value, test.env);

    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 1 });
    expect(test.database.query('SELECT COUNT(*) AS count FROM workspace_attachments').get()).toEqual({ count: 1 });
    expect(test.database.query('SELECT owner_user_id FROM email_messages').get()).toEqual({ owner_user_id: 'user-1' });
    const attachment = test.database.query('SELECT r2_key, sha256 FROM workspace_attachments').get() as { r2_key: string; sha256: string };
    const r2Checksum = test.BUCKET.checksums.get(attachment.r2_key);
    expect(r2Checksum).toBeString();
    if (!r2Checksum) throw new Error('test fixture did not record the R2 checksum');
    expect(attachment.sha256).toBe(r2Checksum);
    expect(test.BUCKET.metadata.get(attachment.r2_key)?.sha256).toBe(attachment.sha256);
    expect(test.BUCKET.objects.size).toBe(2);
    expect(first.rejected()).toBe('');

    await handleInboundEmail(message().value, test.env);
    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 1 });
    expect(test.BUCKET.objects.size).toBe(2);
  });

  test('persists bounded Reply-To, recipient and upstream authentication metadata', async () => {
    const test = environment();
    const raw = new TextEncoder().encode([
      'From: Sender <sender@example.com>',
      'To: Owner <owner@example.test>, Observer <observer@example.com>',
      'Cc: Team <team@example.com>',
      'Reply-To: Support <support@example.com>',
      'Return-Path: <bounce@example.net>',
      'Delivered-To: owner@example.test',
      'Authentication-Results: mx.example.net; spf=pass smtp.mailfrom=example.com; dkim=fail header.d=example.com; dmarc=pass header.from=example.com',
      'X-Private-Trace: do-not-store',
      'Message-ID: <reply-metadata@example.com>',
      'Subject: Metadata',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Metadata body.',
      ''
    ].join('\r\n'));

    await handleInboundEmail(message(raw, 'owner@example.test').value, test.env);
    const row = test.database.query(`
      SELECT to_json, cc_json, reply_to_json, return_path, delivered_to,
        headers_json, authentication_results_json
      FROM email_messages
    `).get() as Record<string, string>;

    expect(JSON.parse(row.to_json)).toEqual([
      { name: 'Owner', email: 'owner@example.test' },
      { name: 'Observer', email: 'observer@example.com' }
    ]);
    expect(JSON.parse(row.cc_json)).toEqual([{ name: 'Team', email: 'team@example.com' }]);
    expect(JSON.parse(row.reply_to_json)).toEqual([{ name: 'Support', email: 'support@example.com' }]);
    expect(row.return_path).toBe('bounce@example.net');
    expect(row.delivered_to).toBe('owner@example.test');
    expect(JSON.parse(row.authentication_results_json)).toEqual([
      { method: 'spf', result: 'pass' },
      { method: 'dkim', result: 'fail' },
      { method: 'dmarc', result: 'pass' }
    ]);
    expect(row.headers_json).not.toContain('do-not-store');
    expect(new TextEncoder().encode(row.headers_json).byteLength).toBeLessThanOrEqual(32 * 1024 + 4096);
  });

  test('cleans newly written R2 objects when D1 persistence fails', async () => {
    const test = environment(true);
    await expect(handleInboundEmail(message().value, test.env)).rejects.toThrow('simulated d1 write failure');
    expect(test.BUCKET.objects.size).toBe(0);
    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 0 });
  });

  test('records incomplete cleanup when R2 rollback deletion fails', async () => {
    const test = environment(true);
    test.BUCKET.failDeletes = true;
    const logs: string[] = [];
    const logger = spyOn(console, 'log').mockImplementation((value) => { logs.push(String(value)); });
    try {
      await expect(handleInboundEmail(message().value, test.env)).rejects.toThrow('simulated d1 write failure');
      expect(test.BUCKET.objects.size).toBeGreaterThan(0);
      expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 0 });
    } finally {
      logger.mockRestore();
    }
    const rollback = logs.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find(({ event }) => event === 'inbound_rollback_incomplete');
    expect(rollback).toMatchObject({ attemptedObjects: 2, failedObjects: 2 });
    expect(JSON.stringify(rollback)).not.toContain('inbound/');
  });

  test('keeps accepted mail when a secondary notification fails', async () => {
    const test = environment();
    test.env.INBOUND_NOTIFICATION_ENABLED = 'true';
    test.env.NOTIFICATION_EMAIL = 'ops@example.test';
    await handleInboundEmail(message().value, test.env);
    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 1 });
  });

  test('sends an inbound notification only when the resolved owner opted in', async () => {
    const test = notificationEnvironment();
    test.database.query(`UPDATE workspace_users SET forwarding_enabled = 1 WHERE id = 'user-1'`).run();
    const captured = await captureResend(() => handleInboundEmail(message(fixtureBytes(), 'owner@example.test').value, test.env));
    expect(captured.requests).toHaveLength(1);
    const payload = JSON.parse(String(captured.requests[0]?.body)) as { to: string[]; tags: Array<{ name: string; value: string }>; text: string };
    expect(payload.to).toEqual(['ops@example.test']);
    expect(payload.tags).toContainEqual({ name: 'flaremail_kind', value: 'inbound_notification' });
    expect(payload.text).toContain('A new inbound message was stored.');
    expect(payload.text).not.toContain('The original email was forwarded.');
  });

  test('honors global and per-user notification switches without inheriting another owner setting', async () => {
    const disabled = notificationEnvironment();
    const disabledCapture = await captureResend(() => handleInboundEmail(message(fixtureBytes(), 'owner@example.test').value, disabled.env));
    expect(disabledCapture.requests).toHaveLength(0);

    const globalOff = notificationEnvironment();
    globalOff.database.query(`UPDATE workspace_users SET forwarding_enabled = 1 WHERE id = 'user-1'`).run();
    globalOff.env.INBOUND_NOTIFICATION_ENABLED = 'false';
    const globalOffCapture = await captureResend(() => handleInboundEmail(message(fixtureBytes(), 'owner@example.test').value, globalOff.env));
    expect(globalOffCapture.requests).toHaveLength(0);

    const unknownOwner = notificationEnvironment();
    const unknownCapture = await captureResend(() => handleInboundEmail(message(fixtureBytes(), 'unknown@example.test').value, unknownOwner.env));
    expect(unknownCapture.requests).toHaveLength(0);

    const multiUser = notificationEnvironment();
    multiUser.database.query(`UPDATE workspace_users SET forwarding_enabled = 1 WHERE id = 'user-1'`).run();
    multiUser.database.query(`INSERT INTO workspace_users
      (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence)
      VALUES ('user-2', 'second@example.test', 'Second', 'Member', 'second@example.test', '', '', 'UTC', 0, '', 0)`).run();
    const firstOwner = await captureResend(() => handleInboundEmail(message(fixtureBytes(), 'owner@example.test').value, multiUser.env));
    const secondOwner = await captureResend(() => handleInboundEmail(message(fixtureBytes(), 'second@example.test').value, multiUser.env));
    expect(firstOwner.requests).toHaveLength(1);
    expect(secondOwner.requests).toHaveLength(0);
    expect(multiUser.database.query(`SELECT owner_user_id FROM email_messages ORDER BY created_at ASC`).all()).toEqual([
      { owner_user_id: 'user-1' },
      { owner_user_id: 'user-2' }
    ]);
  });

  test('stores an unknown recipient without assigning readable ownership', async () => {
    const test = environment();
    await handleInboundEmail(message(fixtureBytes(), 'unknown@example.test').value, test.env);
    expect(test.database.query('SELECT owner_user_id FROM email_messages').get()).toEqual({ owner_user_id: null });
  });

  test('rejects a declared oversize message before reading or writing storage', async () => {
    const test = environment();
    test.env.INBOUND_MAX_RAW_BYTES = '100';
    const oversized = message(fixtureBytes(), 'owner@example.test', 101);
    await expect(handleInboundEmail(oversized.value, test.env)).resolves.toBeUndefined();
    expect(oversized.rejected()).toBe('Message exceeds the inbound size limit.');
    expect(test.BUCKET.objects.size).toBe(0);
  });

  test('returns a safe reject for a MIME attachment limit without failing the invocation', async () => {
    const test = environment();
    test.env.INBOUND_MAX_ATTACHMENT_BYTES = '8';
    const rejected = message(fixtureBytes('oversize-attachment'));
    await expect(handleInboundEmail(rejected.value, test.env)).resolves.toBeUndefined();
    expect(rejected.rejected()).toBe('Message exceeds the MIME attachment limit.');
    expect(test.BUCKET.objects.size).toBe(0);
  });

  test('allows only one claimant for concurrent duplicate inbound messages', async () => {
    const test = environment();
    await Promise.all([handleInboundEmail(message().value, test.env), handleInboundEmail(message().value, test.env)]);
    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 1 });
    expect(test.database.query("SELECT COUNT(*) AS count FROM workspace_inbound_ingest_claims WHERE status = 'completed'").get()).toEqual({ count: 1 });
    expect(test.BUCKET.objects.size).toBe(2);
  });

  test('does not let same Message-ID concurrent variants overwrite the winner', async () => {
    const test = environment();
    const gate = barrier(2);
    const variant = fixtureBytes();
    variant[variant.length - 3] = variant[variant.length - 3] === 65 ? 66 : 65;
    await Promise.all([
      handleInboundEmail(message(fixtureBytes(), 'owner@example.test', undefined, gate).value, test.env),
      handleInboundEmail(message(variant, 'owner@example.test', undefined, gate).value, test.env)
    ]);

    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 1 });
    expect(test.BUCKET.objects.size).toBe(2);
    expect(test.BUCKET.putCount).toBe(2);
    const storedRaw = [...test.BUCKET.objects.values()].find((value) => value.byteLength > 300);
    if (!storedRaw) throw new Error('The winner raw object was not persisted.');
    const sameBytes = (left: Uint8Array, right: Uint8Array) =>
      left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
    expect(sameBytes(storedRaw, fixtureBytes()) || sameBytes(storedRaw, variant)).toBe(true);
  });

  test('releases a claim after R2 failure without deleting another claimant objects', async () => {
    const test = environment();
    test.BUCKET.failPuts = true;
    await expect(handleInboundEmail(message().value, test.env)).rejects.toThrow('simulated r2 write failure');
    expect(test.database.query('SELECT COUNT(*) AS count FROM workspace_inbound_ingest_claims').get()).toEqual({ count: 0 });
    expect(test.BUCKET.objects.size).toBe(0);
  });

  test('keeps objects when D1 finalization fails and completes the claim on recovery', async () => {
    const test = environment();
    test.DB.failClaimCompletion = true;
    await expect(handleInboundEmail(message().value, test.env)).rejects.toThrow('simulated claim finalize failure');
    expect(test.BUCKET.objects.size).toBe(2);
    test.DB.failClaimCompletion = false;
    await handleInboundEmail(message().value, test.env);
    expect(test.database.query("SELECT status FROM workspace_inbound_ingest_claims").get()).toEqual({ status: 'completed' });
  });

  test('recovers a stale claim with a new storage id', async () => {
    const test = environment();
    const dedupeKey = await createInboundDedupeKey('<attachment-1@example.com>', 'owner@example.test', fixtureBytes().buffer);
    test.database.query(`INSERT INTO workspace_inbound_ingest_claims (dedupe_key, storage_id, claim_token, raw_key, status, created_at, updated_at)
      VALUES (?, 'stale-storage', 'stale-token', 'inbound/2020-01-01/stale-storage/message.eml', 'processing', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`).run(dedupeKey);
    await handleInboundEmail(message().value, test.env);
    expect(test.database.query('SELECT storage_id, status FROM workspace_inbound_ingest_claims').get()).toMatchObject({ status: 'completed' });
    expect(test.database.query('SELECT storage_id FROM workspace_inbound_ingest_claims').get()).not.toEqual({ storage_id: 'stale-storage', status: 'completed' });
  });
});
