import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { FLAREMAIL_SCHEMA_VERSION } from '$lib/server/db/schema-version';
import { GET, PATCH } from './+server';
import type { WorkspaceContext } from '$lib/server/workspace/shared';

class Statement {
  private values: unknown[] = [];
  constructor(private readonly db: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this as unknown as D1PreparedStatement; }
  first<T>() { return Promise.resolve((this.db.query(this.sql).get(...this.values as never[]) as T | null) ?? null); }
  all<T>() { return Promise.resolve({ success: true, results: this.db.query(this.sql).all(...this.values as never[]) as T[] }); }
  runSync<T>() { const result = this.db.query(this.sql).run(...this.values as never[]); return { success: true, results: [] as T[], meta: { changes: Number(result.changes ?? 0) } }; }
  run<T>() { return Promise.resolve(this.runSync<T>()); }
}

class D1 {
  constructor(readonly db: Database) {}
  prepare(sql: string) { return new Statement(this.db, sql) as unknown as D1PreparedStatement; }
  batch(statements: D1PreparedStatement[]) { return Promise.resolve(this.db.transaction(() => statements.map((statement) => (statement as unknown as Statement).runSync()))()); }
}

const session: WorkspaceContext = {
  id: 'session-1', userId: 'user-1', storage: 'd1', incomingSequence: 0,
  createdAt: '', updatedAt: '',
  profile: { name: 'Owner', role: '', email: 'owner@example.test', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' }
};

function fixture() {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../../../../../../../schema.sql', import.meta.url), 'utf8'));
  db.query(`INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
    VALUES ('flaremail', ?, '2026-09-09T00:00:00.000Z')`).run(FLAREMAIL_SCHEMA_VERSION);
  const DB = new D1(db);
  const event = {
    request: new Request('https://mail.example.test/api/workspace/notifications/telegram/settings'),
    url: new URL('https://mail.example.test/api/workspace/notifications/telegram/settings'),
    params: {},
    locals: { workspaceSession: session },
    platform: { env: { DB, BUCKET: {}, TELEGRAM_ENABLED: 'false', APP_ENV: 'test', OUTBOUND_PROVIDER: 'demo', ALLOW_FAKE_SERVICES: 'true' } }
  };
  return { db, event };
}

describe('Telegram settings API', () => {
  test('returns deployment/user status with no-store and no cross-user identifier', async () => {
    const { event } = fixture();
    const response = await GET(event as never);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const payload = await response.json() as { data: { globalEnabled: boolean; schemaReady: boolean; userBound: boolean; binding: unknown } };
    expect(payload.data).toMatchObject({ globalEnabled: false, schemaReady: true, userBound: false, binding: null });
    expect(JSON.stringify(payload)).not.toContain('chat');
  });
});

function settingsEvent(body: unknown, bound = true) {
  const value = fixture();
  value.db.exec(`INSERT INTO workspace_users (id, name, role, email, company, location, timezone, signature)
      VALUES ('user-1', 'Owner', 'Owner', '', '', '', 'UTC', '');`);
  if (bound) value.db.exec(`INSERT INTO workspace_telegram_bindings (user_id, binding_id, state, telegram_user_id, telegram_chat_id, enabled, summary_enabled, created_at, updated_at)
      VALUES ('user-1', 'binding', 'active', '42', '42', 1, 1, 'now', 'now');`);
  Object.assign(value.event.platform.env, { TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz', TELEGRAM_BOT_USERNAME: 'flaremail_bot', APP_BASE_URL: 'https://mail.example.test' });
  value.event.request = new Request(value.event.url, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: value.event.url.origin }, body: JSON.stringify(body) });
  return value;
}

test('Telegram AI consent is an independent opt-in and legacy settings updates preserve it', async () => {
  const value = settingsEvent({ aiSummaryEnabled: true });
  const response = await PATCH(value.event as never);
  expect(response.status).toBe(200);
  expect((await response.json() as { data: unknown }).data).toEqual({ settings: { enabled: true, privacyMode: false, summaryEnabled: true, aiSummaryEnabled: true } });
  value.event.request = new Request(value.event.url, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: value.event.url.origin }, body: JSON.stringify({ summaryEnabled: false }) });
  expect((await PATCH(value.event as never)).status).toBe(200);
  expect(value.db.query('SELECT ai_summary_enabled, summary_enabled FROM workspace_telegram_bindings').get()).toEqual({ ai_summary_enabled: 1, summary_enabled: 0 });
});

test.each([null, 'true', 1])('rejects nonboolean Telegram AI consent %j', async (aiSummaryEnabled) => {
  const value = settingsEvent({ aiSummaryEnabled });
  expect((await PATCH(value.event as never)).status).toBe(400);
  expect(value.db.query('SELECT ai_summary_enabled FROM workspace_telegram_bindings').get()).toEqual({ ai_summary_enabled: 0 });
});

test('Telegram AI consent requires a bound authenticated workspace', async () => {
  const unbound = settingsEvent({ aiSummaryEnabled: true }, false);
  expect((await PATCH(unbound.event as never)).status).toBe(409);
  const unauthenticated = settingsEvent({ aiSummaryEnabled: true });
  Object.assign(unauthenticated.event.locals, { workspaceSession: undefined });
  expect((await PATCH(unauthenticated.event as never)).status).toBe(401);
});
