import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { POST } from './+server';
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
  const url = new URL('https://flaremail.test/api/workspace/mailbox/mutate');
  return {
    request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    url,
    params: {},
    locals: { workspaceSession: session },
    platform: { env }
  } as never;
}

afterEach(() => { while (databases.length) databases.pop()?.close(); });

describe('mailbox mutation API scope', () => {
  test('rejects clients that omit the required scope without writing', async () => {
    const { db, env } = fixture();
    const response = await POST(event(env, { action: 'read', ids: ['email:inbound-a'] }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'MAILBOX_SCOPE_REQUIRED' } });
    expect(db.query(`SELECT COUNT(*) AS count FROM workspace_email_states`).get()).toEqual({ count: 0 });
  });

  test('rejects an explicit ID outside the declared address scope without writing', async () => {
    const { db, env } = fixture();
    const response = await POST(event(env, {
      action: 'read',
      ids: ['email:inbound-b'],
      scope: { section: 'inbox', identityFilter: { kind: 'address', id: 'address-a' }, threadScope: 'selected' }
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'MAILBOX_MESSAGE_NOT_FOUND' } });
    expect(db.query(`SELECT COUNT(*) AS count FROM workspace_email_states`).get()).toEqual({ count: 0 });
  });

  test('returns a scoped result for a valid selected-message operation', async () => {
    const { db, env } = fixture();
    const response = await POST(event(env, {
      action: 'read',
      ids: ['email:inbound-a'],
      scope: { section: 'inbox', identityFilter: { kind: 'address', id: 'address-a' }, threadScope: 'selected' }
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { result: {
        summaries: [{ id: 'email:inbound-a' }],
        scope: { section: 'inbox', identityFilter: { kind: 'address', id: 'address-a' }, threadScope: 'selected' },
        metricsScope: { identityFilter: { kind: 'address', id: 'address-a' } }
      } }
    });
    expect(db.query(`SELECT is_read FROM workspace_email_states WHERE email_message_id = 'inbound-a'`).get()).toEqual({ is_read: 1 });
    expect(db.query(`SELECT COUNT(*) AS count FROM workspace_email_states WHERE email_message_id = 'inbound-b'`).get()).toEqual({ count: 0 });
  });

  test('requires an owned label and selected-only scope for cross-folder mutations', async () => {
    const { db, env } = fixture();
    db.query(`INSERT INTO mail_labels (id, owner_user_id, name, name_key, created_at, updated_at)
      VALUES ('label-a', 'user-1', 'Follow Up', 'follow up', '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z')`).run();
    db.query(`INSERT INTO mail_message_labels (owner_user_id, label_id, message_kind, message_id, created_at)
      VALUES ('user-1', 'label-a', 'inbound', 'inbound-a', '2026-09-20T00:00:00Z')`).run();
    const scope = { section: 'label', labelId: 'label-a', identityFilter: null, threadScope: 'selected' };

    const missingLabel = await POST(event(env, { action: 'read', ids: ['email:inbound-a'], scope: { ...scope, labelId: undefined } }));
    expect(missingLabel.status).toBe(400);
    expect(await missingLabel.json()).toMatchObject({ error: { code: 'INVALID_MAILBOX_LABEL_SCOPE' } });
    const expanded = await POST(event(env, {
      action: 'read', ids: ['email:inbound-a'], threadKeys: ['shared'], scope: { ...scope, threadScope: 'owner' }
    }));
    expect(expanded.status).toBe(400);
    expect(await expanded.json()).toMatchObject({ error: { code: 'INVALID_MAILBOX_THREAD_SELECTION' } });
    const outside = await POST(event(env, { action: 'read', ids: ['email:inbound-b'], scope }));
    expect(outside.status).toBe(404);
    expect(await outside.json()).toMatchObject({ error: { code: 'MAILBOX_MESSAGE_NOT_FOUND' } });
    expect(db.query(`SELECT COUNT(*) AS count FROM workspace_email_states`).get()).toEqual({ count: 0 });

    const response = await POST(event(env, { action: 'read', ids: ['email:inbound-a'], scope }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { result: { scope, summaries: [{ id: 'email:inbound-a', read: true }] } } });
    expect(db.query(`SELECT is_read FROM workspace_email_states WHERE email_message_id = 'inbound-a'`).get()).toEqual({ is_read: 1 });
  });
});

test('bulk mutation API retains category scope and rejects another inbox tab', async () => {
  const { db, env } = fixture();
  db.query(`UPDATE email_messages SET inbox_category = 'social' WHERE id = 'inbound-a'`).run();
  const scope = { section: 'inbox', identityFilter: null, threadScope: 'selected', category: 'social' };
  const rejected = await POST(event(env, { action: 'trash', ids: ['email:inbound-b'], scope }));
  expect(rejected.status).toBe(404);
  expect(db.query(`SELECT COUNT(*) AS count FROM workspace_email_states`).get()).toEqual({ count: 0 });
  const accepted = await POST(event(env, { action: 'read', ids: ['email:inbound-a'], scope }));
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ data: { result: { scope } } });
  const invalid = await POST(event(env, { action: 'read', ids: ['email:inbound-a'], scope: { ...scope, category: 'invalid' } }));
  expect(invalid.status).toBe(400);
});
