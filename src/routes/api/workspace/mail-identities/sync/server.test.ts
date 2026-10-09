import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { POST } from './+server';
const databases: Database[] = [];
const originalFetch = globalThis.fetch;
const zoneId = 'a'.repeat(32), accountId = 'b'.repeat(32);
class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private db: Database, private sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this; }
  async first<T>() { return this.db.query(this.sql).get(...this.values) as T | null; }
  async run() { return { success: true, meta: { changes: this.db.query(this.sql).run(...this.values).changes } }; }
}
afterEach(() => { globalThis.fetch = originalFetch; while (databases.length) databases.pop()?.close(); });
test('sync requires the authenticated Owner, uses only read-only provider requests and imports existing identities idempotently', async () => {
  const db = new Database(':memory:');databases.push(db);
  db.exec(readFileSync(new URL('../../../../../../schema.sql', import.meta.url), 'utf8'));
  db.query("INSERT INTO workspace_owner VALUES (1, 'owner-1')").run();
  const env = { DB: { prepare: (sql: string) => new Statement(db, sql) }, MAIL_IDENTITY_WORKER_NAME: 'flaremail',
    MAIL_IDENTITY_ACCOUNT_ID: accountId, CLOUDFLARE_EMAIL_ROUTING_TOKEN: 'fixture-token' };
  const event = (owner: string | null) => ({ url: new URL('https://mail.example.test/api/workspace/mail-identities/sync'),
    request: new Request('https://mail.example.test/api/workspace/mail-identities/sync', { method: 'POST' }),
    platform: { env }, locals: owner ? { workspaceSession: { userId: owner } } : {} }) as never;
  const methods: string[] = [];
  globalThis.fetch = (async (input, init) => {
    methods.push(init?.method ?? 'GET');
    const path = new URL(String(input)).pathname;
    const result = path.endsWith('catch_all') ? { enabled: false, actions: [] }
      : path.endsWith('/rules') ? [{ id: 'route-1', source: 'api', enabled: true, name: 'Existing rule',
        matchers: [{ type: 'literal', field: 'to', value: 'existing@example.test' }], actions: [{ type: 'worker', value: ['flaremail'] }] }]
      : [{ id: zoneId, name: 'example.test', account: { id: accountId } }];
    return Response.json({ success: true, result });
  }) as typeof fetch;
  expect((await POST(event(null))).status).toBe(401);
  expect((await POST(event('other-owner'))).status).toBe(403);
  expect(methods.length).toBe(0);
  const response = await POST(event('owner-1'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { sync: { domainsCreated: 1, addressesCreated: 1, warnings: [] } } });
  expect(await (await POST(event('owner-1'))).json()).toMatchObject({ data: { sync: { domainsCreated: 0, addressesCreated: 0 } } });
  expect(methods).toEqual(['GET', 'GET', 'GET', 'GET', 'GET', 'GET']);
  expect(db.query('SELECT email, routing_owner FROM mail_addresses').get()).toEqual({ email: 'existing@example.test', routing_owner: 'imported' });
});
