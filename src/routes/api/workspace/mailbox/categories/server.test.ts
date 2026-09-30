import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PATCH } from './+server';
import type { WorkspaceContext } from '$lib/server/workspace/shared';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly db: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.db.query(this.sql).get(...this.values) as T | null) ?? null; }
  async all<T>() { return { results: this.db.query(this.sql).all(...this.values) as T[] }; }
  async run() { const result = this.db.query(this.sql).run(...this.values); return { meta: { changes: Number(result.changes) } }; }
}

class D1 {
  constructor(readonly db: Database) {}
  prepare(sql: string) { return new Statement(this.db, sql) as unknown as D1PreparedStatement; }
  async batch(statements: D1PreparedStatement[]) {
    return this.db.transaction(() => statements.map((statement) => (statement as unknown as Statement).run()))();
  }
}

const session: WorkspaceContext = {
  id: 'session-1', userId: 'user-1', storage: 'd1', incomingSequence: 0, createdAt: '', updatedAt: '',
  profile: {
    name: 'Owner', role: 'Owner', email: 'owner@example.test', company: '', location: '', timezone: 'UTC',
    forwardingEnabled: false, signature: ''
  }
};

const databases: Database[] = [];

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(readFileSync(new URL('../../../../../../schema.sql', import.meta.url), 'utf8'));
  db.query(`INSERT INTO workspace_users
    (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence)
    VALUES ('user-1', 'owner@example.test', 'Owner', 'Owner', 'owner@example.test', '', '', 'UTC', 0, '', 0)`).run();
  db.query(`INSERT INTO mail_domains (id, owner_user_id, domain_name, cloudflare_zone_id, worker_name) VALUES
    ('domain-a', 'user-1', 'alpha.example', 'zone-a', 'flaremail'),
    ('domain-b', 'user-1', 'beta.example', 'zone-b', 'flaremail')`).run();
  db.query(`INSERT INTO mail_addresses (id, owner_user_id, domain_id, email, local_part, receive_enabled, routing_state) VALUES
    ('address-a', 'user-1', 'domain-a', 'ada@alpha.example', 'ada', 1, 'active'),
    ('address-b', 'user-1', 'domain-b', 'ada@beta.example', 'ada', 1, 'active')`).run();
  db.query(`INSERT INTO email_messages
    (id, owner_user_id, "from", "to", subject, "timestamp", snippet, raw_key, direction,
      message_id, thread_key, mail_domain_id, mail_address_id)
    VALUES
      ('inbound-a', 'user-1', 'Sender <sender@example.test>', 'ada@alpha.example', 'A', '2026-09-20T12:00:00Z', 'A', 'raw/a', 'inbound', '<shared@example.test>', 'shared', 'domain-a', 'address-a'),
      ('inbound-b', 'user-1', 'Sender <sender@example.test>', 'ada@beta.example', 'B', '2026-09-20T12:00:00Z', 'B', 'raw/b', 'inbound', '<shared@example.test>', 'shared', 'domain-b', 'address-b')`).run();
  return { db, env: { DB: new D1(db) } };
}

function event(env: { DB: D1 }, body: unknown) {
  const url = new URL('https://flaremail.test/api/workspace/mailbox/categories');
  return {
    request: new Request(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    url,
    params: {},
    locals: { workspaceSession: session },
    platform: { env }
  } as never;
}

afterEach(() => { while (databases.length) databases.pop()?.close(); });

describe('inbox category API', () => {
  const scope = { section: 'inbox', identityFilter: { kind: 'address', id: 'address-a' }, category: 'all' };

  test('updates the selected inbox message and can restore automatic classification', async () => {
    const { db, env } = fixture();
    const response = await PATCH(event(env, { ids: ['email:inbound-a'], category: 'social', scope }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: {
      summaries: [{ id: 'email:inbound-a', inboxCategory: 'social', inboxCategoryOverride: 'social' }], scope
    } });
    expect(db.query(`SELECT inbox_category FROM email_messages WHERE id = 'inbound-b'`).get()).toEqual({ inbox_category: null });
    const restored = await PATCH(event(env, { ids: ['email:inbound-a'], category: null, scope }));
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ data: {
      summaries: [{ id: 'email:inbound-a', inboxCategory: 'primary', inboxCategoryOverride: null }]
    } });
  });

  test('validates categories, scope, selection shape and size before writing', async () => {
    const { db, env } = fixture();
    for (const body of [
      {}, null, { ids: [], category: 'primary', scope },
      { ids: ['email:inbound-a'], category: 'all', scope },
      { ids: ['email:inbound-a'], category: 'primary' },
      { ids: ['email:inbound-a'], category: 'primary', scope: { section: 'inbox' } },
      { ids: ['email:inbound-a'], category: 'primary', scope: { ...scope, category: 'invalid' } },
      { ids: Array.from({ length: 101 }, (_, index) => `email:${index}`), category: 'primary', scope },
      { ids: [123], category: 'primary', scope }
    ]) expect((await PATCH(event(env, body))).status).toBe(400);
    expect(db.query(`SELECT COUNT(*) AS count FROM email_messages WHERE inbox_category IS NOT NULL`).get()).toEqual({ count: 0 });
  });

  test('rejects a mixed out-of-address selection without a partial update', async () => {
    const { db, env } = fixture();
    const response = await PATCH(event(env, { ids: ['email:inbound-a', 'email:inbound-b'], category: 'primary', scope }));
    expect(response.status).toBe(404);
    expect(db.query(`SELECT COUNT(*) AS count FROM email_messages WHERE inbox_category IS NOT NULL`).get()).toEqual({ count: 0 });
  });

  test('requires an authenticated workspace session', async () => {
    const { env } = fixture();
    const value = event(env, { ids: ['email:inbound-a'], category: 'primary', scope }) as unknown as { locals: object };
    value.locals = {};
    expect((await PATCH(value as never)).status).toBe(401);
  });
});
