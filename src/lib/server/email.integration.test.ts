import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
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
  failPuts = false;
  async put(key: string, value: ArrayBuffer | Uint8Array) {
    if (this.failPuts) throw new Error('simulated r2 write failure');
    this.objects.set(key, value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value.slice(0)));
    return {} as R2Object;
  }
  async delete(key: string) { this.objects.delete(key); }
}

const fixtureBytes = () => {
  const bytes = readFileSync(new URL('../../../tests/fixtures/eml/base64-attachment.eml', import.meta.url));
  return new Uint8Array(bytes);
};

const message = (bytes = fixtureBytes(), to = 'owner@example.test', declaredSize = bytes.byteLength) => {
  let rejected = '';
  const value = {
    from: 'alice@example.com',
    to,
    raw: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
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

describe('inbound email persistence', () => {
  test('stores raw, parsed metadata and attachment exactly once', async () => {
    const test = environment();
    const first = message();
    await handleInboundEmail(first.value, test.env);

    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 1 });
    expect(test.database.query('SELECT COUNT(*) AS count FROM workspace_attachments').get()).toEqual({ count: 1 });
    expect(test.database.query('SELECT owner_user_id FROM email_messages').get()).toEqual({ owner_user_id: 'user-1' });
    expect(test.BUCKET.objects.size).toBe(2);
    expect(first.rejected()).toBe('');

    await handleInboundEmail(message().value, test.env);
    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 1 });
    expect(test.BUCKET.objects.size).toBe(2);
  });

  test('cleans newly written R2 objects when D1 persistence fails', async () => {
    const test = environment(true);
    await expect(handleInboundEmail(message().value, test.env)).rejects.toThrow('simulated d1 write failure');
    expect(test.BUCKET.objects.size).toBe(0);
    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 0 });
  });

  test('keeps accepted mail when a secondary notification fails', async () => {
    const test = environment();
    test.env.INBOUND_NOTIFICATION_ENABLED = 'true';
    test.env.NOTIFICATION_EMAIL = 'ops@example.test';
    await handleInboundEmail(message().value, test.env);
    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 1 });
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

  test('allows only one claimant for concurrent duplicate inbound messages', async () => {
    const test = environment();
    await Promise.all([handleInboundEmail(message().value, test.env), handleInboundEmail(message().value, test.env)]);
    expect(test.database.query('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 1 });
    expect(test.database.query("SELECT COUNT(*) AS count FROM workspace_inbound_ingest_claims WHERE status = 'completed'").get()).toEqual({ count: 1 });
    expect(test.BUCKET.objects.size).toBe(2);
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
