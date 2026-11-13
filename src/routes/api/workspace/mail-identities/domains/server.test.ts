import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { POST } from './+server';
import { PATCH } from './[domainId]/+server';
import { POST as REFRESH } from './[domainId]/refresh/+server';

const zoneId = 'a'.repeat(32);
const accountId = 'b'.repeat(32);
const databases: Database[] = [];
const originalFetch = globalThis.fetch;
class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private db: Database, private sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this; }
  async first<T>() { return this.db.query(this.sql).get(...this.values) as T | null; }
  async all<T>() { return { results: this.db.query(this.sql).all(...this.values) as T[] }; }
  async run() { return { success: true, meta: { changes: this.db.query(this.sql).run(...this.values).changes } }; }
}
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(readFileSync(new URL('../../../../../../schema.sql', import.meta.url), 'utf8'));
  return { DB: { prepare: (sql: string) => new Statement(db, sql) },
    MAIL_IDENTITY_WORKER_NAME: 'flaremail', MAIL_IDENTITY_ACCOUNT_ID: accountId,
    CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN: 'read-token' };
}
function event(env: ReturnType<typeof fixture>, method: string, body: unknown, owner: string | null = 'owner-1', domainId = '') {
  const url = new URL('https://mail.example.test/api/workspace/mail-identities/domains/' + domainId);
  return { url, params: { domainId }, platform: { env },
    locals: owner ? { workspaceSession: { userId: owner } } : {},
    request: new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) } as never;
}
afterEach(() => { globalThis.fetch = originalFetch; while (databases.length) databases.pop()?.close(); });

test('domain endpoints require a session, reject client-chosen Worker targets, and protect settings ownership', async () => {
  const env = fixture();
  const input = { domainName: 'example.com', zoneId };
  expect((await POST(event(env, 'POST', input, null))).status).toBe(401);
  expect((await POST(event(env, 'POST', { ...input, workerName: 'untrusted' }))).status).toBe(400);
  expect((await POST(event(env, 'POST', null))).status).toBe(400);
  const requests: string[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push((init?.method ?? 'GET') + ' ' + String(url));
    return Response.json({ success: true, result: { id: zoneId, name: 'example.com', account: { id: accountId } } });
  }) as typeof fetch;
  const response = await POST(event(env, 'POST', input));
  expect(response.status).toBe(201);
  const payload = await response.json() as { data: { domain: { id: string } } };
  const id = payload.data.domain.id;
  expect((await POST(event(env, 'POST', input))).status).toBe(200);
  expect(requests.every((request) => request === 'GET https://api.cloudflare.com/client/v4/zones/' + zoneId)).toBe(true);
  expect((await PATCH(event(env, 'PATCH', { worker_name: 'untrusted' }, 'owner-1', id))).status).toBe(400);
  expect((await PATCH(event(env, 'PATCH', {}, 'owner-1', id))).status).toBe(400);
  expect((await PATCH(event(env, 'PATCH', { enabled: 'false' }, 'owner-1', id))).status).toBe(400);
  expect((await PATCH(event(env, 'PATCH', { unknownRecipientPolicy: ['collect'] }, 'owner-1', id))).status).toBe(400);
  expect((await PATCH(event(env, 'PATCH', { enabled: false }, 'other-owner', id))).status).toBe(404);
  expect((await PATCH(event(env, 'PATCH', { enabled: false }, 'owner-1', id))).status).toBe(200);
});

test('foreground health endpoint scopes observations to the Owner, enforces cooldown, and never mutates providers', async () => {
  const env = fixture();
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO mail_domains (
    id, owner_user_id, domain_name, cloudflare_zone_id, cloudflare_account_id, worker_name, created_at, updated_at
  ) VALUES (?, 'owner-1', 'example.com', ?, ?, 'flaremail', ?, ?)`).bind(id, zoneId, accountId, timestamp, timestamp).run();
  expect((await REFRESH(event(env, 'POST', {}, null, id))).status).toBe(401);
  expect((await REFRESH(event(env, 'POST', {}, 'other-owner', id))).status).toBe(404);
  expect((await REFRESH(event(env, 'POST', {}, 'owner-1', 'invalid'))).status).toBe(404);
  const requests: string[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    requests.push((init?.method ?? 'GET') + ' ' + path);
    const result = path.includes('catch_all') ? { enabled: true, actions: [{ type: 'worker', value: ['flaremail'] }] }
      : path.includes('/rules') ? [] : { id: zoneId, name: 'example.com', account: { id: accountId } };
    return Response.json({ success: true, result });
  }) as typeof fetch;
  const result = await REFRESH(event(env, 'POST', {}, 'owner-1', id));
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ data: { refresh: { cloudflare: { checked: 1 }, resend: { state: 'not_configured' } } } });
  expect((await REFRESH(event(env, 'POST', {}, 'owner-1', id))).status).toBe(200);
  expect(requests).toHaveLength(3);
  expect(requests.every((request) => request.startsWith('GET '))).toBe(true);
});
