import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, spyOn, test } from 'bun:test';
import { createInboundDedupeKey, handleInboundEmail } from './email';
import { readPreInboundBindings } from './inbound/pre-inbound';
import { claimInboundRoutingOwner, findInboundRoutingOwner } from './inbound/routing-ownership';
import { updateMailDomain } from './mail-identities/domains';
import { createManagedMailAddress, deleteManagedMailAddress, type MailIdentityRoutingDependencies } from './mail-identities/routing';
import { syncCloudflareMailIdentities } from './mail-identities/sync';
import { parseAddress } from './workspace/shared';
import { FLAREMAIL_SCHEMA_VERSION } from './db/schema-version';
import { addBlockedSender, listBlockedSenders, listQuarantinedMail, releaseQuarantinedMail, removeBlockedSender } from './db/blocked-senders';

class TestStatement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly database: Database, readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.database.query(this.sql).get(...this.values) as T | null) ?? null; }
  async all<T>() { return { success: true, results: this.database.query(this.sql).all(...this.values) as T[] }; }
  runSync<T>() {
    const result = this.database.query(this.sql).run(...this.values);
    return { success: true, results: [] as T[], meta: { changes: Number(result.changes ?? 0) } };
  }
  async run<T>() { return this.runSync<T>(); }
}

class TestD1 {
  failBatch = false;
  failTelegramBatch = false;
  failAiBatch = false;
  failBatchAfterStatements: number | null = null;
  failClaimCompletion = false;
  readonly batches: string[][] = [];
  constructor(readonly database: Database) {}
  prepare(sql: string) {
    if (this.failClaimCompletion && sql.includes("UPDATE workspace_inbound_ingest_claims SET status = 'completed'")) {
      return { bind: () => ({ run: async () => { throw new Error('simulated claim finalize failure'); } }) } as unknown as D1PreparedStatement;
    }
    return new TestStatement(this.database, sql) as unknown as D1PreparedStatement;
  }
  async batch(statements: D1PreparedStatement[]) {
    const sql = statements.map((statement) => (statement as unknown as TestStatement).sql);
    this.batches.push(sql);
    if (this.failAiBatch && sql.some((statement) => statement.includes('mail_ai_jobs'))) throw new Error('simulated optional AI queue failure');
    if (this.failBatch) throw new Error('simulated d1 write failure');
    if (this.failTelegramBatch && sql.some((statement) => statement.includes('workspace_telegram_deliveries'))) {
      throw new Error('simulated optional Telegram write failure');
    }
    return this.database.transaction(() => {
      const results = [];
      for (const [index, statement] of statements.entries()) {
        results.push((statement as unknown as TestStatement).runSync());
        if (this.failBatchAfterStatements !== null && index + 1 >= this.failBatchAfterStatements) {
          throw new Error('simulated mid-batch write failure');
        }
      }
      return results;
    })();
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

const pauseNextWrite = (bucket: TestBucket) => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const put = bucket.put.bind(bucket);
  const spy = spyOn(bucket, 'put').mockImplementationOnce(async (key, value, options) => {
    entered();
    await paused;
    return put(key, value, options);
  });
  return { started, release, restore: () => spy.mockRestore() };
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
    ) VALUES ('user-1', 'legacy-login@example.test', 'Owner', 'Owner', 'profile@example.test', '', '', 'UTC', 0, '', 0)
  `).run();
  database.query('INSERT INTO workspace_owner (singleton, user_id) VALUES (1, ?)').run('user-1');
  database.query(`
    INSERT INTO mail_domains (id, owner_user_id, domain_name, cloudflare_zone_id, worker_name)
    VALUES ('domain-1', 'user-1', 'example.test', 'zone-1', 'flaremail')
  `).run();
  addManagedAddress(database, 'address-1', 'owner@example.test');
  const DB = new TestD1(database);
  DB.failBatch = failBatch;
  const BUCKET = new TestBucket();
  return { database, DB, BUCKET, env: { DB, BUCKET, OUTBOUND_PROVIDER: 'demo' } as unknown as import('./cloudflare').CloudflareEnv };
};

const addManagedAddress = (database: Database, id: string, email: string) => {
  database.query(`
    INSERT INTO mail_addresses (
      id, owner_user_id, domain_id, email, local_part, receive_enabled, routing_state, routing_rule_id, routing_rule_source, routing_owner
    ) VALUES (?, 'user-1', 'domain-1', ?, ?, 1, 'active', ?, 'api', 'flaremail')
  `).run(id, email, email.slice(0, email.indexOf('@')), `rule-${id}`);
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

const telegramEnvironment = () => {
  const test = environment();
  test.database.query(`INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
    VALUES ('flaremail', ?, '2026-09-09T00:00:00.000Z')`).run(FLAREMAIL_SCHEMA_VERSION);
  test.env = {
    ...test.env,
    APP_ENV: 'test',
    TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
    TELEGRAM_WEBHOOK_SECRET: 'test-telegram-webhook-secret',
    TELEGRAM_BOT_USERNAME: 'flaremail_bot',
    APP_BASE_URL: 'http://127.0.0.1:8787'
  } as unknown as import('./cloudflare').CloudflareEnv;
  test.database.query(`INSERT INTO workspace_telegram_bindings
    (user_id, binding_id, state, telegram_user_id, telegram_chat_id, enabled, privacy_mode, summary_enabled,
     authorization_version, created_at, updated_at)
    VALUES ('user-1', 'binding-1', 'active', '42', '42', 1, 0, 1, 1,
      '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`).run();
  return test;
};

const captureTelegram = async <T>(action: () => Promise<T>) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 9001 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })) as unknown as typeof fetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = previousFetch;
  }
};

describe('single Worker PRE inbound', () => {
  function isolatedInbound() {
    const production = notificationEnvironment();
    const preview = telegramEnvironment();
    addManagedAddress(preview.database, 'address-pre', 'pre@example.test');
    const env = {
      ...production.env,
      AUTO_REPLY_ENABLED: 'true',
      TELEGRAM_ENABLED: preview.env.TELEGRAM_ENABLED,
      TELEGRAM_BOT_TOKEN: preview.env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_BOT_USERNAME: preview.env.TELEGRAM_BOT_USERNAME,
      APP_BASE_URL: preview.env.APP_BASE_URL,
      PRE_INBOUND_SETTINGS: { recipient: 'pre@example.test', enabled: true },
      PRE_INBOUND_DB: preview.env.DB,
      PRE_INBOUND_BUCKET: preview.env.BUCKET
    };
    return { production, preview, env };
  }

  test('stores by SMTP recipient exactly once and skips production providers and preview queues', async () => {
    const { production, preview, env } = isolatedInbound();
    preview.database.query("UPDATE workspace_users SET forwarding_enabled = 1 WHERE id = 'user-1'").run();
    preview.database.query("INSERT INTO workspace_settings (user_id, settings_json) VALUES ('user-1', ?)").run(
      JSON.stringify({ mailAi: { enabled: true, automaticClassification: true, classificationConsent: crypto.randomUUID() } })
    );
    const { requests } = await captureResend(async () => {
      for (let i = 0; i < 2; i++) {
        const inbound = message(fixtureBytes(), ' PRE@EXAMPLE.TEST ');
        inbound.value.headers.set('to', 'owner@example.test');
        await handleInboundEmail(inbound.value, env);
        expect(inbound.rejected()).toBe('');
      }
    });
    expect(requests).toHaveLength(0);
    expect(production.DB.batches).toHaveLength(0);
    expect(production.BUCKET.objects.size).toBe(0);
    expect(preview.database.query('SELECT "to", mail_address_id FROM email_messages').all())
      .toEqual([{ to: 'pre@example.test', mail_address_id: 'address-pre' }]);
    const raw = [...preview.BUCKET.objects.entries()].filter(([key]) => key.endsWith('/message.eml'));
    expect(raw.map(([, bytes]) => bytes)).toEqual([fixtureBytes()]);
    expect(preview.database.query('SELECT id FROM workspace_telegram_deliveries').all()).toEqual([]);
    expect(preview.database.query('SELECT message_id FROM mail_ai_jobs').all()).toEqual([]);
  });

  test('retains the local test marker while ignoring injected secret bindings', async () => {
    const { production, env } = isolatedInbound();
    const inbound = message(fixtureBytes(), 'pre@example.test');
    const marker = 'flaremail-rc1-pre-smoke';
    inbound.value.headers.set('x-flaremail-runtime-correlation', marker);
    const logs = spyOn(console, 'log');
    try {
      await handleInboundEmail(inbound.value, env);
      expect(logs.mock.calls.some(([line]) => String(line).includes(marker))).toBe(true);
    } finally {
      logs.mockRestore();
    }
    const ordinary = message();
    await handleInboundEmail(ordinary.value, {
      ...production.env,
      PRE_INBOUND_SETTINGS: '{"recipient":"pre@example.test","enabled":true}',
      PRE_INBOUND_DB: 'ignored',
      PRE_INBOUND_BUCKET: 'ignored'
    } as unknown as typeof env);
    expect(ordinary.rejected()).toBe('');
    expect(production.database.query('SELECT "to" FROM email_messages').all()).toEqual([{ to: 'owner@example.test' }]);
  });

  test('rejects paused, subaddress, disabled and unregistered recipients before writing', async () => {
    const { production, preview, env } = isolatedInbound();
    addManagedAddress(production.database, 'address-production-conflict', 'pre+tag@example.test');
    const reject = async (to: string, enabled = true) => {
      const inbound = message(fixtureBytes(), to);
      await handleInboundEmail(inbound.value, { ...env, PRE_INBOUND_SETTINGS: { ...env.PRE_INBOUND_SETTINGS, enabled } });
      expect(inbound.rejected()).toBe('The recipient address is not enabled.');
    };
    await reject('pre@example.test', false);
    await reject('PRE+tag@EXAMPLE.TEST');
    preview.database.query("UPDATE mail_addresses SET receive_enabled = 0 WHERE id = 'address-pre'").run();
    await reject('pre@example.test');
    preview.database.query("UPDATE mail_addresses SET receive_enabled = 1, owner_user_id = 'different-owner' WHERE id = 'address-pre'").run();
    const wrongOwner = message(fixtureBytes(), 'pre@example.test');
    await handleInboundEmail(wrongOwner.value, env);
    expect(wrongOwner.rejected()).toBe('The recipient address is not managed by this domain.');
    preview.database.query("DELETE FROM mail_addresses WHERE id = 'address-pre'").run();
    preview.database.query(`UPDATE mail_domains SET unknown_recipient_policy = 'collect', catch_all_target = 'this_worker',
      catch_all_checked_at = ?`).run(new Date().toISOString());
    await reject('pre@example.test');
    for (const storage of [production, preview]) {
      expect(storage.database.query('SELECT storage_id FROM workspace_inbound_ingest_claims').all()).toEqual([]);
      expect(storage.BUCKET.objects.size).toBe(0);
    }
  });

  test('fails closed on partial config, invalid address, missing Owner and storage failures', async () => {
    const { production, preview, env } = isolatedInbound();
    expect(() => readPreInboundBindings([], false, false)).toThrow('PRE_INBOUND_CONFIGURATION_INVALID');
    expect(() => readPreInboundBindings({ recipient: 'pre@example.test' }, true, true)).toThrow('PRE_INBOUND_CONFIGURATION_INVALID');
    for (const invalid of [
      { PRE_INBOUND_SETTINGS: undefined },
      ...['pre..test@example.test', 'pre', 'pre+tag@example.test', 'pre@example.test.'].map((recipient) =>
        ({ PRE_INBOUND_SETTINGS: { recipient, enabled: true } })),
      { PRE_INBOUND_BUCKET: undefined }
    ]) {
      await expect(handleInboundEmail(message().value, { ...env, ...invalid })).rejects.toThrow('PRE_INBOUND_');
    }
    const deliver = () => handleInboundEmail(message(fixtureBytes(), 'pre@example.test').value, env);
    preview.database.query('DELETE FROM workspace_owner').run();
    await expect(deliver()).rejects.toThrow('INBOUND_OWNER_MAPPING_UNAVAILABLE');
    preview.database.query("INSERT INTO workspace_owner (singleton, user_id) VALUES (1, 'user-1')").run();
    preview.database.query("UPDATE workspace_users SET id = 'orphaned' WHERE id = 'user-1'").run();
    await expect(deliver()).rejects.toThrow('INBOUND_OWNER_MAPPING_UNAVAILABLE');
    preview.database.query("UPDATE workspace_users SET id = 'user-1' WHERE id = 'orphaned'").run();
    preview.BUCKET.failPuts = true;
    await expect(deliver()).rejects.toThrow('simulated r2 write failure');
    const prepare = spyOn(preview.DB, 'prepare').mockImplementation(() => { throw new Error('PRE D1 unavailable'); });
    try {
      await expect(deliver()).rejects.toThrow('PRE D1 unavailable');
      expect(production.DB.batches).toHaveLength(0);
      expect(production.BUCKET.objects.size).toBe(0);
      const put = spyOn(preview.BUCKET, 'put');
      const normal = message(fixtureBytes(), 'owner+tag@example.test');
      normal.value.headers.set('to', 'pre@example.test');
      const count = prepare.mock.calls.length;
      await handleInboundEmail(normal.value, { ...env, AUTO_REPLY_ENABLED: 'false' });
      expect(normal.rejected()).toBe('');
      expect(prepare).toHaveBeenCalledTimes(count);
      expect(put).not.toHaveBeenCalled();
      put.mockRestore();
      expect(production.database.query('SELECT "to" FROM email_messages').all()).toEqual([{ to: 'owner+tag@example.test' }]);
    } finally {
      prepare.mockRestore();
    }
  });
});

describe('shared PRE and production inbound routing', () => {
  function sharedInbound() {
    const production = environment();
    const preview = environment();
    const registry = new Database(':memory:');
    registry.exec(readFileSync(new URL('../../../routing-migrations/0001_ownership.sql', import.meta.url), 'utf8'));
    const binding = new TestD1(registry);
    const DB = binding as unknown as D1Database;
    const withRouting = (env: typeof production.env, environment: 'production' | 'preview') => ({
      ...env,
      INBOUND_ROUTING_DB: DB,
      INBOUND_ROUTING_SCOPE: { environment }
    });
    const prod = withRouting(production.env, 'production');
    const pre = withRouting(preview.env, 'preview');
    const email = {
      ...prod,
      PRE_INBOUND_SETTINGS: { recipient: null, enabled: true },
      PRE_INBOUND_DB: pre.DB,
      PRE_INBOUND_BUCKET: pre.BUCKET
    };
    return { production, preview, binding, DB, prod, pre, email };
  }

  function readyCatchAll(database: Database) {
    database.query(`UPDATE mail_domains SET catch_all_target = 'this_worker', catch_all_checked_at = ?`)
      .run(new Date().toISOString());
  }

  test('dispatches shared-domain and exclusive-domain recipients, keeps the two mail stores isolated', async () => {
    const { production, preview, DB, prod, email } = sharedInbound();
    addManagedAddress(preview.database, 'address-pre', 'pre@example.test');
    preview.database.query(`INSERT INTO mail_domains
      (id, owner_user_id, domain_name, cloudflare_zone_id, worker_name, unknown_recipient_policy, catch_all_target, catch_all_checked_at)
      VALUES ('pre-domain', 'user-1', 'preview.test', 'zone-pre', 'flaremail', 'collect', 'this_worker', ?)`).run(new Date().toISOString());
    readyCatchAll(production.database);
    await updateMailDomain(prod, 'user-1', 'domain-1', { unknownRecipientPolicy: 'collect' });
    await claimInboundRoutingOwner(DB, 'mailbox', 'pre@example.test', 'preview');
    await claimInboundRoutingOwner(DB, 'mailbox', 'owner@example.test', 'production');
    await claimInboundRoutingOwner(DB, 'catch_all', 'preview.test', 'preview');
    const delivery = async (to: string, enabled = true) => {
      const inbound = message(fixtureBytes(), to);
      await handleInboundEmail(inbound.value, { ...email, PRE_INBOUND_SETTINGS: { recipient: null, enabled } });
      return inbound.rejected();
    };
    for (const recipient of ['PRE+tag@EXAMPLE.TEST', 'unknown@preview.test', 'owner@example.test', 'unknown@example.test']) {
      expect(await delivery(recipient)).toBe('');
    }
    expect(await delivery('outside@example.net')).not.toBe('');
    expect(await delivery('pre@example.test', false)).not.toBe('');
    preview.database.query(`UPDATE mail_addresses SET lifecycle_status = 'deleted', receive_enabled = 0 WHERE id = 'address-pre'`).run();
    expect(await delivery('pre@example.test')).not.toBe('');
    await claimInboundRoutingOwner(DB, 'mailbox', 'pending@example.test', 'preview');
    expect(await delivery('pending@example.test')).not.toBe('');
    const recipients = (db: Database) => db.query('SELECT "to" FROM email_messages ORDER BY "to"').all();
    expect(recipients(production.database)).toEqual([{ to: 'owner@example.test' }, { to: 'unknown@example.test' }]);
    expect(recipients(preview.database)).toEqual([{ to: 'pre+tag@example.test' }, { to: 'unknown@preview.test' }]);
    expect([...production.BUCKET.objects.keys()].filter((key) => key.endsWith('/message.eml'))).toHaveLength(2);
    expect([...preview.BUCKET.objects.keys()].filter((key) => key.endsWith('/message.eml'))).toHaveLength(2);
  });

  test('reserves one address family and one catch-all across concurrent configuration operations', async () => {
    const { production, preview, DB, prod, pre } = sharedInbound();
    await expect(createManagedMailAddress({
      ...prod,
      PRE_INBOUND_SETTINGS: { recipient: ' Reserved@EXAMPLE.TEST ', enabled: false }
    }, 'user-1', { domainId: 'domain-1', address: 'reserved+tag' }))
      .rejects.toMatchObject({ code: 'MAIL_ROUTING_OWNERSHIP_CONFLICT' });
    expect(await findInboundRoutingOwner(DB, 'mailbox', 'reserved@example.test')).toBeNull();
    const attempts = await Promise.allSettled([
      createManagedMailAddress(prod, 'user-1', { domainId: 'domain-1', address: 'Alias' }),
      createManagedMailAddress(pre, 'user-1', { domainId: 'domain-1', address: 'ALIAS+test' })
    ]);
    // The successful reservation stays assigned even when the provider call fails.
    const errors = attempts.map((attempt) => attempt.status === 'rejected' ? attempt.reason.code : null).sort();
    expect(errors).toEqual(['CLOUDFLARE_ROUTING_NOT_CONFIGURED', 'MAIL_ROUTING_OWNERSHIP_CONFLICT']);
    const owner = await findInboundRoutingOwner(DB, 'mailbox', 'alias@example.test');
    expect(owner).not.toBeNull();
    const wrongEnvironment = owner === 'production' ? 'preview' : 'production';
    const databases = { production: production.database, preview: preview.database };
    const losingDatabase = databases[wrongEnvironment];
    expect(losingDatabase.query("SELECT COUNT(*) AS count FROM mail_addresses WHERE local_part LIKE 'alias%'").get()).toEqual({ count: 0 });

    await claimInboundRoutingOwner(DB, 'mailbox', 'owner@example.test', 'preview');
    const dependencies: MailIdentityRoutingDependencies = { cloudflareClient: () => ({
      listRules: async () => { throw new Error('unowned mailbox must not query the provider'); },
      createWorkerRule: async () => { throw new Error('unexpected provider write'); },
      deleteRule: async () => { throw new Error('unexpected provider write'); }
    }) };
    await expect(deleteManagedMailAddress(prod, 'user-1', 'address-1', dependencies))
      .rejects.toMatchObject({ code: 'MAIL_ROUTING_OWNERSHIP_CONFLICT' });
    expect(production.database.query("SELECT lifecycle_status FROM mail_addresses WHERE id = 'address-1'").get())
      .toEqual({ lifecycle_status: 'active' });

    readyCatchAll(production.database);
    readyCatchAll(preview.database);
    const collect = (env: typeof prod) => updateMailDomain(env, 'user-1', 'domain-1', { unknownRecipientPolicy: 'collect' });
    const collectors = await Promise.allSettled([collect(prod), collect(pre)]);
    expect(collectors.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    const catchAllOwner = await findInboundRoutingOwner(DB, 'catch_all', 'example.test');
    const [winner, loser] = catchAllOwner === 'production' ? [prod, pre] : [pre, prod];
    await updateMailDomain(winner, 'user-1', 'domain-1', { unknownRecipientPolicy: 'reject' });
    await expect(collect(loser)).rejects.toMatchObject({ code: 'MAIL_ROUTING_OWNERSHIP_CONFLICT' });
  });

  test('allows PRE to manage the exact legacy reservation and blocks its tagged variants', async () => {
    const { pre, email, DB, preview } = sharedInbound();
    const PRE_INBOUND_SETTINGS = { recipient: 'reserved@example.test', enabled: false };
    const previewSettings = { ...pre, PRE_INBOUND_SETTINGS: { ...PRE_INBOUND_SETTINGS, previewApp: true as const } };
    for (const env of [previewSettings, { ...email, PRE_INBOUND_SETTINGS }]) {
      await expect(createManagedMailAddress(env, 'user-1', { domainId: 'domain-1', address: 'reserved+tag' }))
        .rejects.toMatchObject({ code: 'MAIL_ROUTING_OWNERSHIP_CONFLICT' });
    }
    await expect(createManagedMailAddress(previewSettings, 'user-1', { domainId: 'domain-1', address: 'reserved' }))
      .rejects.toMatchObject({ code: 'CLOUDFLARE_ROUTING_NOT_CONFIGURED' });
    expect(await findInboundRoutingOwner(DB, 'mailbox', 'reserved@example.test')).toBe('preview');
    expect(preview.database.query("SELECT email FROM mail_addresses WHERE local_part LIKE 'reserved%'").all())
      .toEqual([{ email: 'reserved@example.test' }]);
  });

  test('disabling a domain preserves its selection without claiming or transferring catch-all ownership', async () => {
    const { prod, DB, production } = sharedInbound();
    production.database.query("UPDATE mail_domains SET unknown_recipient_policy = 'collect'").run();
    const update = (enabled: boolean) => updateMailDomain(prod, 'user-1', 'domain-1', { enabled, unknownRecipientPolicy: 'collect' });
    expect((await update(false))?.enabled).toBe(0);
    expect(await findInboundRoutingOwner(DB, 'catch_all', 'example.test')).toBeNull();
    await claimInboundRoutingOwner(DB, 'catch_all', 'example.test', 'preview');
    expect((await update(false))?.enabled).toBe(0);
    await expect(update(true)).rejects.toMatchObject({ code: 'MAIL_ROUTING_OWNERSHIP_CONFLICT' });
    expect(await findInboundRoutingOwner(DB, 'catch_all', 'example.test')).toBe('preview');
  });

  test('verifies a newly selected catch-all even when saving a disabled domain', async () => {
    const { prod, DB, production } = sharedInbound();
    const update = () => updateMailDomain(prod, 'user-1', 'domain-1', { enabled: false, unknownRecipientPolicy: 'collect' });
    await expect(update()).rejects.toMatchObject({ code: 'MAIL_DOMAIN_COLLECT_NOT_READY' });
    expect(production.database.query('SELECT unknown_recipient_policy FROM mail_domains').get())
      .toEqual({ unknown_recipient_policy: 'reject' });
    readyCatchAll(production.database);
    await updateMailDomain(prod, 'user-1', 'domain-1', { enabled: false });
    expect(await updateMailDomain(prod, 'user-1', 'domain-1', { unknownRecipientPolicy: 'collect' }))
      .toMatchObject({ enabled: 0, unknown_recipient_policy: 'collect' });
    expect(await findInboundRoutingOwner(DB, 'catch_all', 'example.test')).toBeNull();
    expect(await updateMailDomain(prod, 'user-1', 'domain-1', { enabled: true })).toMatchObject({ enabled: 1 });
    expect(await findInboundRoutingOwner(DB, 'catch_all', 'example.test')).toBe('production');
  });

  test('a fixed PRE app without shared routing keeps identity settings read-only and rejects email events', async () => {
    const { env, database } = environment();
    const previewApp = { ...env, PRE_INBOUND_SETTINGS: { recipient: 'reserved@example.test', enabled: false, previewApp: true as const } };
    await expect(createManagedMailAddress(previewApp, 'user-1', { domainId: 'domain-1', address: 'reserved' }))
      .rejects.toMatchObject({ code: 'MAIL_ROUTING_FIXED_PRE_READ_ONLY' });
    await expect(syncCloudflareMailIdentities(previewApp, 'user-1'))
      .rejects.toMatchObject({ code: 'MAIL_ROUTING_FIXED_PRE_READ_ONLY' });
    await expect(updateMailDomain(previewApp, 'user-1', 'domain-1', { enabled: false }))
      .rejects.toMatchObject({ code: 'MAIL_ROUTING_FIXED_PRE_READ_ONLY' });
    for (const recipient of ['reserved@example.test', 'owner@example.test']) {
      await expect(handleInboundEmail(message(fixtureBytes(), recipient).value, previewApp)).rejects.toThrow('PRE_INBOUND_CONFIGURATION_INVALID');
    }
    expect(database.query('SELECT "to" FROM email_messages').all()).toEqual([]);
  });

  test('native shared PRE acceptance cannot reserve or mutate mail routing', async () => {
    const { pre, DB, preview } = sharedInbound();
    const stage = { ...pre, INBOUND_ROUTING_SCOPE: { environment: 'preview' as const, readOnly: true as const } };
    await expect(createManagedMailAddress(stage, 'user-1', { domainId: 'domain-1', address: 'unassigned' }))
      .rejects.toMatchObject({ code: 'MAIL_ROUTING_PREVIEW_READ_ONLY' });
    await expect(syncCloudflareMailIdentities(stage, 'user-1')).rejects.toMatchObject({ code: 'MAIL_ROUTING_PREVIEW_READ_ONLY' });
    await expect(updateMailDomain(stage, 'user-1', 'domain-1', { enabled: false }))
      .rejects.toMatchObject({ code: 'MAIL_ROUTING_PREVIEW_READ_ONLY' });
    expect(await findInboundRoutingOwner(DB, 'mailbox', 'unassigned@example.test')).toBeNull();
    expect(preview.database.query('SELECT enabled FROM mail_domains WHERE id = ?').get('domain-1')).toEqual({ enabled: 1 });
  });

  test('requires a PRE mailbox claim to deliver the exact legacy reservation under shared routing', async () => {
    const { production, preview, binding, DB, email } = sharedInbound();
    addManagedAddress(preview.database, 'address-pre', 'pre@example.test');
    await claimInboundRoutingOwner(DB, 'catch_all', 'example.test', 'production');
    await claimInboundRoutingOwner(DB, 'mailbox', 'owner@example.test', 'production');
    const deliverFixed = async (recipient: string) => {
      const inbound = message(fixtureBytes(), recipient);
      await handleInboundEmail(inbound.value, { ...email, PRE_INBOUND_SETTINGS: { recipient, enabled: true } });
      return inbound.rejected();
    };
    expect(await deliverFixed('pre@example.test')).not.toBe('');
    expect(await deliverFixed('owner@example.test')).not.toBe('');
    const failed = spyOn(binding, 'prepare').mockImplementation(() => { throw new Error('routing D1 unavailable'); });
    try {
      await expect(deliverFixed('pre@example.test')).rejects.toThrow('routing D1 unavailable');
    } finally {
      failed.mockRestore();
    }
    expect(production.BUCKET.objects.size).toBe(0);
    expect(preview.BUCKET.objects.size).toBe(0);
    await claimInboundRoutingOwner(DB, 'mailbox', 'pre@example.test', 'preview');
    expect(await deliverFixed('pre@example.test')).toBe('');
    expect(preview.database.query('SELECT "to" FROM email_messages').all()).toEqual([{ to: 'pre@example.test' }]);
  });

  test('sync imports only assigned rules and production delivery survives a PRE mail-store outage', async () => {
    const { production, preview, binding, DB, prod, email } = sharedInbound();
    await claimInboundRoutingOwner(DB, 'mailbox', 'owner@example.test', 'production');
    await claimInboundRoutingOwner(DB, 'mailbox', 'prod@example.test', 'production');
    await claimInboundRoutingOwner(DB, 'mailbox', 'pre@example.test', 'preview');
    const zone = { id: 'a'.repeat(32), name: 'example.test', accountId: 'b'.repeat(32) };
    production.database.query("UPDATE mail_domains SET cloudflare_zone_id = ?, cloudflare_account_id = ? WHERE id = 'domain-1'")
      .run(zone.id, zone.accountId);
    const actions = [{ type: 'worker', value: ['flaremail'] }];
    const registryReads = spyOn(binding, 'prepare');
    const synced = await syncCloudflareMailIdentities({
      ...prod,
      MAIL_IDENTITY_WORKER_NAME: 'flaremail', MAIL_IDENTITY_ACCOUNT_ID: zone.accountId,
      CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN: 'fixture'
    }, 'user-1', {
      listZones: async () => [zone],
      getCatchAll: async () => ({ enabled: true, actions }),
      listRules: async () => ['prod', 'pre', ...Array.from({ length: 400 }, (_, index) => 'unassigned-' + index)].map((local) => ({
        id: local, name: local, enabled: true, source: 'api',
        matchers: [{ type: 'literal', field: 'to', value: local + '@example.test' }], actions
      }))
    });
    expect(synced).toMatchObject({ addressesCreated: 1, skippedRules: 401 });
    expect(registryReads.mock.calls.filter(([sql]) => sql.includes('json_each'))).toHaveLength(3);
    registryReads.mockRestore();
    expect(production.database.query('SELECT email FROM mail_addresses ORDER BY email').all())
      .toEqual([{ email: 'owner@example.test' }, { email: 'prod@example.test' }]);
    expect(production.database.query('SELECT unknown_recipient_policy FROM mail_domains').get()).toEqual({ unknown_recipient_policy: 'reject' });

    const previewDb = spyOn(preview.DB, 'prepare').mockImplementation(() => { throw new Error('PRE D1 unavailable'); });
    try {
      await handleInboundEmail(message().value, email);
      expect(previewDb).not.toHaveBeenCalled();
      await expect(handleInboundEmail(message(fixtureBytes(), 'pre@example.test').value, email)).rejects.toThrow('PRE D1 unavailable');
    } finally {
      previewDb.mockRestore();
    }
    const routingDb = spyOn(binding, 'prepare').mockImplementation(() => { throw new Error('routing D1 unavailable'); });
    try {
      await expect(handleInboundEmail(message(fixtureBytes(), 'prod@example.test').value, email)).rejects.toThrow('routing D1 unavailable');
    } finally {
      routingDb.mockRestore();
    }
    expect(production.database.query('SELECT "to" FROM email_messages').all()).toEqual([{ to: 'owner@example.test' }]);
  });
});

describe('blocked senders', () => {
  test('matches the visible From, stores attachments, suppresses notifications and keeps a released duplicate released', async () => {
    const test = notificationEnvironment();
    test.database.query("UPDATE workspace_users SET forwarding_enabled = 1 WHERE id = 'user-1'").run();
    test.env.AUTO_REPLY_ENABLED = 'true';
    await addBlockedSender(test.env.DB, 'user-1', ' FILES@EXAMPLE.COM ');
    await addBlockedSender(test.env.DB, 'user-1', 'files@example.com');
    expect(await listBlockedSenders(test.env.DB, 'user-1')).toHaveLength(1);
    const requests = await captureResend(async () => handleInboundEmail(message().value, test.env));
    expect(requests.requests).toHaveLength(0);
    expect(test.database.query('SELECT COUNT(*) AS n FROM email_messages').get()).toEqual({ n: 1 });
    expect(test.database.query('SELECT COUNT(*) AS n FROM workspace_attachments').get()).toEqual({ n: 1 });
    expect(test.BUCKET.objects.size).toBe(2);
    const page = await listQuarantinedMail(test.env.DB, 'user-1', null);
    expect(page.items).toHaveLength(1);
    expect((await listQuarantinedMail(test.env.DB, 'user-2', null)).items).toHaveLength(0);
    await expect(releaseQuarantinedMail(test.env.DB, 'user-2', page.items[0].id)).rejects.toMatchObject({ status: 404 });
    await removeBlockedSender(test.env.DB, 'user-1', 'files@example.com');
    expect((await listQuarantinedMail(test.env.DB, 'user-1', null)).items).toHaveLength(1);
    await addBlockedSender(test.env.DB, 'user-1', 'files@example.com');
    await releaseQuarantinedMail(test.env.DB, 'user-1', page.items[0].id);
    await handleInboundEmail(message().value, test.env);
    expect((await listQuarantinedMail(test.env.DB, 'user-1', null)).items).toHaveLength(0);
    expect(await listBlockedSenders(test.env.DB, 'user-1')).toHaveLength(1);
    await removeBlockedSender(test.env.DB, 'user-1', 'FILES@example.com');
    expect(await listBlockedSenders(test.env.DB, 'user-1')).toHaveLength(0);
  });

  test('validates rules, scopes them to the owner, and falls back safely if lookup is unavailable', async () => {
    const test = environment();
    await expect(addBlockedSender(test.env.DB, 'user-1', '*@*.example.com')).rejects.toMatchObject({ status: 400 });
    await addBlockedSender(test.env.DB, 'other-owner', 'files@example.com');
    await addBlockedSender(test.env.DB, 'user-1', 'alice@example.com');
    await handleInboundEmail(message().value, test.env);
    expect((await listQuarantinedMail(test.env.DB, 'user-1', null)).items).toHaveLength(0);

    const unavailable = environment();
    unavailable.database.exec('DROP TABLE blocked_senders');
    await handleInboundEmail(message().value, unavailable.env);
    expect(unavailable.database.query('SELECT COUNT(*) AS n FROM email_messages').get()).toEqual({ n: 1 });
    expect(unavailable.database.query('SELECT COUNT(*) AS n FROM workspace_email_states').get()).toEqual({ n: 0 });
  });

  test('does not retain a partial quarantine when the mail transaction fails', async () => {
    const test = environment(true);
    await addBlockedSender(test.env.DB, 'user-1', 'files@example.com');
    await expect(handleInboundEmail(message().value, test.env)).rejects.toThrow();
    expect(test.database.query('SELECT COUNT(*) AS n FROM email_messages').get()).toEqual({ n: 0 });
    expect(test.database.query('SELECT COUNT(*) AS n FROM workspace_email_states').get()).toEqual({ n: 0 });
    expect(test.BUCKET.objects.size).toBe(0);
  });

  test('does not enqueue Telegram for quarantined mail', async () => {
    const test = telegramEnvironment();
    await addBlockedSender(test.env.DB, 'user-1', 'files@example.com');
    await captureTelegram(() => handleInboundEmail(message().value, test.env));
    expect(test.database.query('SELECT COUNT(*) AS n FROM workspace_telegram_deliveries').get()).toEqual({ n: 0 });
    expect((await listQuarantinedMail(test.env.DB, 'user-1', null)).items).toHaveLength(1);
  });

  test('does not match the envelope when a From header is present but invalid', async () => {
    for (const [header, sender] of [['From: not-an-address', ''], ['From:', ''], ['From: Bad <foo..bar@example.com>', 'Bad <foo..bar@example.com>']]) {
      const test = environment();
      await addBlockedSender(test.env.DB, 'user-1', 'alice@example.com');
      const raw = new TextEncoder().encode(`${header}\r\nTo: owner@example.test\r\nSubject: Invalid From\r\n\r\nhello`);
      await handleInboundEmail(message(raw).value, test.env);
      expect((await listQuarantinedMail(test.env.DB, 'user-1', null)).items).toHaveLength(0);
      expect(test.database.query('SELECT "from" AS sender FROM email_messages').get()).toEqual({ sender });
    }
  });

  test('preserves valid MIME senders outside the blocklist address syntax', async () => {
    for (const [header, sender] of [['From: "a@b"@example.com', '"a@b"@example.com'], ['From: José <josé@example.com>', 'José <josé@example.com>']]) {
      const test = environment();
      await addBlockedSender(test.env.DB, 'user-1', 'alice@example.com');
      const raw = new TextEncoder().encode(`${header}\r\nTo: owner@example.test\r\nSubject: Special sender\r\n\r\nhello`);
      await handleInboundEmail(message(raw).value, test.env);
      expect(test.database.query('SELECT "from" AS sender FROM email_messages').get()).toEqual({ sender });
      expect((await listQuarantinedMail(test.env.DB, 'user-1', null)).items).toHaveLength(0);
    }
  });

  test('uses the envelope sender only when From is missing', async () => {
    const test = environment();
    await addBlockedSender(test.env.DB, 'user-1', 'alice@example.com');
    const raw = new TextEncoder().encode('To: owner@example.test\r\nSubject: No From\r\n\r\nhello');
    await handleInboundEmail(message(raw).value, test.env);
    expect((await listQuarantinedMail(test.env.DB, 'user-1', null)).items).toHaveLength(1);
    expect(test.database.query('SELECT "from" AS sender FROM email_messages').get()).toEqual({ sender: 'alice@example.com' });
  });

  test.each(['Alice "<Team \\ Friends', '"Alice"', '"'])('preserves encoded sender name %s', async (name) => {
    const test = environment();
    const raw = new TextEncoder().encode(`From: =?UTF-8?B?${btoa(name)}?= <alice@example.com>\r\nTo: owner@example.test\r\nSubject: Hello\r\n\r\nBody`);
    await handleInboundEmail(message(raw).value, test.env);
    const row = test.database.query('SELECT "from" AS sender FROM email_messages').get() as { sender: string };
    expect(parseAddress(row.sender)).toEqual({ name, email: 'alice@example.com' });
  });

  test('uses the sender address rather than its display name for new fallback thread keys', async () => {
    const test = environment();
    for (const name of ['Alice A', 'Alice B']) {
      const raw = new TextEncoder().encode(`From: ${name} <alice@example.com>\r\nTo: owner@example.test\r\nSubject: Same subject\r\n\r\n${name}`);
      await handleInboundEmail(message(raw).value, test.env);
    }
    const rows = test.database.query('SELECT thread_key FROM email_messages ORDER BY id').all() as Array<{ thread_key: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every(({ thread_key }) => thread_key === 'same subject::alice@example.com')).toBe(true);
  });

  test('keeps unreliable senders in separate fallback threads', async () => {
    const test = environment();
    for (const sender of ['alice@example.com', 'bob@example.com']) {
      const raw = new TextEncoder().encode(`From: Bad <foo..bar@example.com>\r\nTo: owner@example.test\r\nSubject: Same subject\r\n\r\n${sender}`);
      const inbound = message(raw).value;
      Object.defineProperty(inbound, 'from', { value: sender });
      await handleInboundEmail(inbound, test.env);
    }
    const rows = test.database.query('SELECT id, "from" AS sender, thread_key FROM email_messages').all() as Array<{ id: string; sender: string; thread_key: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.sender === 'Bad <foo..bar@example.com>' && row.thread_key === `same subject::message:email:${row.id}`)).toBe(true);
  });
});

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

  test('persists an inbound Telegram outbox row in the same D1 batch as the mail', async () => {
    const test = telegramEnvironment();
    await captureTelegram(() => handleInboundEmail(message().value, test.env));

    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 1 });
    expect(test.database.query('SELECT COUNT(*) AS count FROM workspace_telegram_deliveries').get()).toEqual({ count: 1 });
    expect(test.DB.batches[0]?.some((statement) => statement.includes('INSERT INTO email_messages'))).toBe(true);
    expect(test.DB.batches[0]?.some((statement) => statement.includes('workspace_telegram_deliveries'))).toBe(true);
  });

  test('falls back to core mail persistence when the optional Telegram statement fails', async () => {
    const test = telegramEnvironment();
    test.DB.failTelegramBatch = true;
    await captureTelegram(() => handleInboundEmail(message().value, test.env));

    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 1 });
    expect(test.database.query('SELECT COUNT(*) AS count FROM workspace_telegram_deliveries').get()).toEqual({ count: 0 });
    expect(test.DB.batches).toHaveLength(2);
    expect(test.DB.batches[1]?.some((statement) => statement.includes('workspace_telegram_deliveries'))).toBe(false);
  });

  test('rolls back the mail and Telegram outbox together after a mid-batch failure', async () => {
    const test = telegramEnvironment();
    test.DB.failBatchAfterStatements = 2;
    await expect(captureTelegram(() => handleInboundEmail(message().value, test.env))).rejects.toThrow('simulated mid-batch write failure');

    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 0 });
    expect(test.database.query('SELECT COUNT(*) AS count FROM workspace_telegram_deliveries').get()).toEqual({ count: 0 });
    expect(test.database.query('SELECT COUNT(*) AS count FROM workspace_inbound_ingest_claims').get()).toEqual({ count: 0 });
    expect(test.BUCKET.objects.size).toBe(0);
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

  test('honors global and Owner notification switches across multiple managed addresses', async () => {
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
    addManagedAddress(multiUser.database, 'address-2', 'second@example.test');
    const firstOwner = await captureResend(() => handleInboundEmail(message(fixtureBytes(), 'owner@example.test').value, multiUser.env));
    const secondOwner = await captureResend(() => handleInboundEmail(message(fixtureBytes(), 'second@example.test').value, multiUser.env));
    expect(firstOwner.requests).toHaveLength(1);
    expect(secondOwner.requests).toHaveLength(1);
    expect(multiUser.database.query(`SELECT owner_user_id FROM email_messages ORDER BY created_at ASC`).all()).toEqual([
      { owner_user_id: 'user-1' },
      { owner_user_id: 'user-1' }
    ]);
  });

  test('rejects an unknown address before reading raw mail or writing R2', async () => {
    const test = environment();
    let reads = 0;
    const rejected = message(fixtureBytes(), 'unknown@example.test');
    Object.defineProperty(rejected.value, 'raw', {
      value: {
        getReader() {
          reads += 1;
          throw new Error('the raw stream must not be read');
        }
      }
    });
    await handleInboundEmail(rejected.value, test.env);
    expect(rejected.rejected()).toBe('The recipient address is not enabled.');
    expect(reads).toBe(0);
    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 0 });
    expect(test.BUCKET.objects.size).toBe(0);
  });

  test('stores plus-address deliveries under the base identity with distinct envelope dedupe keys', async () => {
    const test = environment();
    const recipients = ['owner@example.test', 'owner+news@example.test', 'owner+alerts@example.test'];
    for (const recipient of recipients) {
      const inbound = message(fixtureBytes(), recipient);
      await handleInboundEmail(inbound.value, test.env);
      expect(inbound.rejected()).toBe('');
    }
    await handleInboundEmail(message(fixtureBytes(), recipients[1]).value, test.env);
    const rows = test.database.query(`SELECT "to", mail_address_id, owner_user_id, recipient_status
      FROM email_messages ORDER BY "to"`).all();
    expect(rows).toEqual([...recipients].sort().map((recipient) => ({
      to: recipient, mail_address_id: 'address-1', owner_user_id: 'user-1', recipient_status: 'managed'
    })));
    expect(test.database.query('SELECT COUNT(DISTINCT dedupe_key) AS count FROM email_messages').get()).toEqual({ count: 3 });
    expect(test.database.query('SELECT COUNT(*) AS count FROM mail_addresses').get()).toEqual({ count: 1 });
    expect(test.BUCKET.objects.size).toBe(6);
    test.database.close();
  });

  test('fails a fresh interrupted-claim redelivery without accepting or rejecting unpersisted mail', async () => {
    const test = environment();
    const dedupeKey = await createInboundDedupeKey('<attachment-1@example.com>', 'owner@example.test', fixtureBytes().buffer);
    const now = new Date().toISOString();
    test.database.query(`INSERT INTO workspace_inbound_ingest_claims
      (dedupe_key, storage_id, claim_token, raw_key, status, created_at, updated_at)
      VALUES (?, 'interrupted', 'original-token', 'inbound/interrupted/message.eml', 'processing', ?, ?)`)
      .run(dedupeKey, now, now);
    const inbound = message();
    await expect(handleInboundEmail(inbound.value, test.env)).rejects.toThrow('INBOUND_CLAIM_BUSY');
    expect(inbound.rejected()).toBe('');
    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 0 });
    expect(test.database.query('SELECT storage_id, claim_token, status FROM workspace_inbound_ingest_claims').get())
      .toEqual({ storage_id: 'interrupted', claim_token: 'original-token', status: 'processing' });
    expect(test.BUCKET.objects.size).toBe(0);
    test.database.close();
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

  test('only accepts a concurrent duplicate after the winning invocation persists mail', async () => {
    const test = environment();
    const write = pauseNextWrite(test.BUCKET);
    const first = handleInboundEmail(message().value, test.env);
    await write.started;
    const duplicate = message();
    try {
      await expect(handleInboundEmail(duplicate.value, test.env)).rejects.toMatchObject({ code: 'INBOUND_CLAIM_BUSY' });
      expect(duplicate.rejected()).toBe('');
      expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 0 });
      expect(test.BUCKET.objects.size).toBe(0);
    } finally {
      write.release();
      await first;
      write.restore();
    }
    await handleInboundEmail(message().value, test.env);
    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 1 });
    expect(test.database.query("SELECT COUNT(*) AS count FROM workspace_inbound_ingest_claims WHERE status = 'completed'").get()).toEqual({ count: 1 });
    expect(test.BUCKET.objects.size).toBe(2);
    expect(test.BUCKET.putCount).toBe(2);
    test.database.close();
  });

  test('does not let same Message-ID concurrent variants overwrite the winner', async () => {
    const test = environment();
    const gate = barrier(2);
    const variant = fixtureBytes();
    variant[variant.length - 3] = variant[variant.length - 3] === 65 ? 66 : 65;
    const write = pauseNextWrite(test.BUCKET);
    const invocations = [
      handleInboundEmail(message(fixtureBytes(), 'owner@example.test', undefined, gate).value, test.env),
      handleInboundEmail(message(variant, 'owner@example.test', undefined, gate).value, test.env)
    ];
    const concurrent = Promise.allSettled(invocations);
    await write.started;
    // Keep the winner paused until the competing invocation finishes its
    // busy-claim check, so this does not depend on scheduler timing.
    try {
      await expect(Promise.race(invocations)).rejects.toMatchObject({ code: 'INBOUND_CLAIM_BUSY' });
    } finally {
      write.release();
      await concurrent;
      write.restore();
    }
    const results = await concurrent;
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected');
    expect(failed?.status === 'rejected' ? failed.reason : null).toMatchObject({ code: 'INBOUND_CLAIM_BUSY' });

    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 1 });
    expect(test.BUCKET.objects.size).toBe(2);
    expect(test.BUCKET.putCount).toBe(2);
    const storedRaw = [...test.BUCKET.objects.values()].find((value) => value.byteLength > 300);
    if (!storedRaw) throw new Error('The winner raw object was not persisted.');
    const sameBytes = (left: Uint8Array, right: Uint8Array) =>
      left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
    expect(sameBytes(storedRaw, fixtureBytes()) || sameBytes(storedRaw, variant)).toBe(true);
    test.database.close();
  });

  test('does not acknowledge the busy copy when the winning invocation subsequently fails', async () => {
    const test = environment(true);
    const write = pauseNextWrite(test.BUCKET);
    const first = Promise.allSettled([handleInboundEmail(message().value, test.env)]);
    await write.started;
    const duplicate = message();
    try {
      await expect(handleInboundEmail(duplicate.value, test.env)).rejects.toMatchObject({ code: 'INBOUND_CLAIM_BUSY' });
      expect(duplicate.rejected()).toBe('');
    } finally {
      write.release();
      await first;
      write.restore();
    }
    const [result] = await first;
    expect(result?.status === 'rejected' ? result.reason.message : null).toBe('simulated d1 write failure');
    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 0 });
    expect(test.database.query('SELECT COUNT(*) AS count FROM workspace_inbound_ingest_claims').get()).toEqual({ count: 0 });
    expect(test.BUCKET.objects.size).toBe(0);
    test.DB.failBatch = false;
    await handleInboundEmail(message().value, test.env);
    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 1 });
    expect(test.BUCKET.objects.size).toBe(2);
    test.database.close();
  });

  test('accepts an already committed winner observed after the first dedupe lookup missed it', async () => {
    const test = environment();
    await handleInboundEmail(message().value, test.env);
    test.database.query("UPDATE workspace_inbound_ingest_claims SET status = 'processing', completed_at = NULL").run();
    const prepare = test.DB.prepare.bind(test.DB);
    let firstLookup = true;
    const spy = spyOn(test.DB, 'prepare').mockImplementation((sql) => {
      if (firstLookup && sql.includes('SELECT id, raw_key FROM email_messages WHERE dedupe_key = ?')) {
        firstLookup = false;
        return { bind: () => ({ first: async () => null }) } as unknown as D1PreparedStatement;
      }
      return prepare(sql);
    });
    try {
      await expect(handleInboundEmail(message().value, test.env)).resolves.toBeUndefined();
      expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 1 });
      expect(test.BUCKET.objects.size).toBe(2);
      expect(test.BUCKET.putCount).toBe(2);
    } finally {
      spy.mockRestore();
      test.database.close();
    }
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

test('new inbound mail enqueues classification without Telegram and optional queue failure cannot lose mail', async () => {
  for (const failAiBatch of [false, true]) {
    const value = environment();
    value.database.query(`INSERT INTO workspace_settings (user_id,settings_json) VALUES ('user-1', ?)`)
      .run(JSON.stringify({ mailAi: { enabled: true, automaticClassification: true, classificationConsent: crypto.randomUUID() } }));
    value.DB.failAiBatch = failAiBatch;
    await handleInboundEmail(message().value, value.env);
    expect(value.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 1 });
    expect(value.database.query('SELECT COUNT(*) AS count FROM mail_ai_jobs').get()).toEqual({ count: failAiBatch ? 0 : 1 });
    value.database.close();
  }
});
