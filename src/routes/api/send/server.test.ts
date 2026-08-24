import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { FLAREMAIL_SCHEMA_VERSION } from '$lib/server/db/schema-version';
import type { WorkspaceSession } from '$lib/server/workspace/shared';
import { POST } from './+server';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly database: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.database.query(this.sql).get(...this.values) as T | null) ?? null; }
  async all<T>() { return { results: this.database.query(this.sql).all(...this.values) as T[] }; }
  async run() { this.database.query(this.sql).run(...this.values); return { success: true }; }
}

class D1 {
  constructor(readonly database: Database) {}
  prepare(sql: string) { return new Statement(this.database, sql) as unknown as D1PreparedStatement; }
  async batch(statements: D1PreparedStatement[]) {
    for (const statement of statements) await (statement as unknown as Statement).run();
    return [];
  }
}

class Bucket {
  async put() {}
  async get() { return null; }
  async delete() {}
}

function setup() {
  const database = new Database(':memory:');
  database.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
  database.query(`INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
    VALUES ('flaremail', ?, '2026-08-19T00:00:00.000Z')`).run(FLAREMAIL_SCHEMA_VERSION);
  database.query(`INSERT INTO workspace_users
    (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence)
    VALUES ('user-1', 'owner@example.test', 'Owner', 'Owner', 'owner@example.test', '', '', 'UTC', 0, '', 0)`).run();
  const session: WorkspaceSession = {
    id: 'session-1', userId: 'user-1', profile: { name: 'Owner', role: 'Owner', email: 'owner@example.test', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' },
    mailbox: { inbox: [], sent: [], drafts: [] }, incomingSequence: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), storage: 'd1'
  };
  return {
    database,
    session,
    env: {
      DB: new D1(database), BUCKET: new Bucket(), APP_ENV: 'test',
      ALLOW_FAKE_SERVICES: 'true', OUTBOUND_PROVIDER: 'fake', OUTBOUND_FROM_EMAIL: 'mail@example.test'
    }
  };
}

function event(body: unknown, setupValue: ReturnType<typeof setup>, headers: Record<string, string> = {}) {
  return {
    request: new Request('https://mail.example.test/api/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Request-ID': 'send-test', ...headers },
      body: JSON.stringify(body)
    }),
    url: new URL('https://mail.example.test/api/send'),
    platform: { env: setupValue.env },
    locals: { workspaceSession: setupValue.session }
  } as never;
}

describe('/api/send compatibility contract', () => {
  test('accepts a full ComposeInput and returns both response envelopes', async () => {
    const value = setup();
    const response = await POST(event({
      to: 'alice@example.net', subject: 'Full compose', body: 'Plain text', html: '<p>Plain text</p>'
    }, value, { 'Idempotency-Key': 'full-send' }));
    const body = await response.json() as Record<string, any>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, success: true, id: expect.stringContaining('fake-'), messageId: expect.stringContaining('sent-live-') });
    expect(body.data).toMatchObject({ message: { id: body.messageId, deliveryProviderMessageId: body.id }, metrics: expect.any(Object) });
    expect(new Date(body.sentAt).toISOString()).toBe(body.sentAt);
  });

  test('accepts the MicroBin-compatible html/text payload and falls back to request idempotency', async () => {
    const value = setup();
    const response = await POST(event({
      to: ['alice@example.net', 'bob@example.net'], subject: 'Simple compose', html: '<strong>Hello</strong>', text: 'Hello'
    }, value));
    const body = await response.json() as Record<string, any>;
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.message.id).toBe(body.messageId);
    expect(value.database.query('SELECT idempotency_key FROM workspace_messages').get()).toEqual({ idempotency_key: 'flaremail:send:user-1:send-test' });
  });

  test('reuses workspace authentication and rejects unauthenticated requests', async () => {
    const value = setup();
    const request = event({ to: 'alice@example.net', subject: 'No auth', html: '<p>Hi</p>' }, value);
    (request as { locals: Record<string, unknown> }).locals.workspaceSession = null;
    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'AUTHENTICATION_REQUIRED' } });
  });

  test('rejects HTML with no safe body after sanitization', async () => {
    const value = setup();
    const response = await POST(event({
      to: 'alice@example.net', subject: 'Unsafe only', html: '<script>alert(1)</script>'
    }, value));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldErrors: { html: [expect.any(String)] } }
    });
  });

  test('returns Retry-After when the per-user send window is exhausted', async () => {
    const value = setup();
    const now = Date.now();
    value.database.query(`INSERT INTO workspace_outbound_rate_limits
      (user_id, attempt_count, window_started_at, reset_at, updated_at)
      VALUES ('user-1', 10, ?, ?, ?)`).run(now, now + 60_000, now);
    const response = await POST(event({
      to: 'alice@example.net', subject: 'Limited', text: 'Hello'
    }, value, { 'Idempotency-Key': 'limited-send' }));
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'SEND_RATE_LIMITED' } });
  });
});
