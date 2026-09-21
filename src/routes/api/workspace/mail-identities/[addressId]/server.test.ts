import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DELETE } from './+server';
import { GET as getDeletePreview } from './delete-preview/+server';

const ownerId = '20000000-0000-4000-8000-000000000001';
const domainId = '30000000-0000-4000-8000-000000000001';
const addressId = '40000000-0000-4000-8000-000000000001';
const zoneId = 'a'.repeat(32);
const ruleId = 'b'.repeat(32);
const email = 'person@example.test';
const workerName = 'flaremail-worker';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly database: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.database.query(this.sql).get(...this.values) as T | null) ?? null; }
  async all<T>() { return { results: this.database.query(this.sql).all(...this.values) as T[] }; }
  async run() {
    const result = this.database.query(this.sql).run(...this.values);
    return { success: true, meta: { changes: result.changes } };
  }
}

class D1 {
  constructor(readonly database: Database) {}
  prepare(sql: string) { return new Statement(this.database, sql); }
}

const databases: Database[] = [];
const originalFetch = globalThis.fetch;

function fixture() {
  const database = new Database(':memory:');
  databases.push(database);
  database.exec(readFileSync(new URL('../../../../../../schema.sql', import.meta.url), 'utf8'));
  database.query(`INSERT INTO mail_domains (id, owner_user_id, domain_name, cloudflare_zone_id, worker_name, catch_all_target, catch_all_checked_at)
    VALUES (?, ?, 'example.test', ?, ?, 'external', '2026-09-21T09:00:00.000Z')`).run(domainId, ownerId, zoneId, workerName);
  database.query(`INSERT INTO mail_addresses (id, owner_user_id, domain_id, email, local_part, routing_state, routing_rule_id, routing_rule_source, routing_owner, receive_enabled)
    VALUES (?, ?, ?, ?, 'person', 'active', ?, 'api', 'flaremail', 1)`).run(addressId, ownerId, domainId, email, ruleId);
  return {
    database,
    env: {
      DB: new D1(database),
      CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN: 'read-token',
      CLOUDFLARE_EMAIL_ROUTING_TOKEN: 'management-token'
    }
  };
}

function event(env: ReturnType<typeof fixture>['env'], method: string, body?: unknown, authenticated = true) {
  const url = new URL(`https://mail.example.test/api/workspace/mail-identities/${addressId}`);
  return {
    request: new Request(url, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    }),
    url,
    params: { addressId },
    locals: authenticated ? { workspaceSession: { id: 'session-1', userId: ownerId, storage: 'd1', incomingSequence: 0, createdAt: '', updatedAt: '', profile: {} } } : {},
    platform: { env }
  } as never;
}

function cloudflareMock() {
  let routePresent = true;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push(method + ' ' + url.pathname);
    if (url.pathname === `/client/v4/zones/${zoneId}`) {
      return Response.json({ success: true, result: { id: zoneId, name: 'example.test', account: { id: 'account-1' } } });
    }
    if (url.pathname === `/client/v4/zones/${zoneId}/email/routing/rules/catch_all`) {
      return Response.json({ success: true, result: { enabled: true, actions: [{ type: 'forward', value: ['elsewhere@example.net'] }] } });
    }
    if (url.pathname === `/client/v4/zones/${zoneId}/email/routing/rules` && method === 'GET') {
      return Response.json({
        success: true,
        result: routePresent ? [{
          id: ruleId,
          name: 'FlareMail managed address ' + addressId,
          enabled: true,
          source: 'api',
          matchers: [{ type: 'literal', field: 'to', value: email }],
          actions: [{ type: 'worker', value: [workerName] }]
        }] : [],
        result_info: { total_pages: 1 }
      });
    }
    if (url.pathname === `/client/v4/zones/${zoneId}/email/routing/rules/${ruleId}` && method === 'DELETE') {
      routePresent = false;
      return Response.json({ success: true, result: {} });
    }
    return Response.json({ success: false, errors: [{ code: 1000, message: 'unexpected test request' }] }, { status: 500 });
  }) as typeof fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  while (databases.length) databases.pop()?.close();
});

describe('mail address deletion endpoints', () => {
  test('returns an authenticated fresh preview with explicit route and catch-all consequences', async () => {
    const { database, env } = fixture();
    const provider = cloudflareMock();
    const response = await getDeletePreview(event(env, 'GET'));
    const payload = await response.json() as { data: { preview: Record<string, unknown> } };

    expect(response.status).toBe(200);
    expect(payload.data.preview).toMatchObject({
      historyRetained: true,
      cloudflare: {
        state: 'verified',
        route: { observation: 'managed_worker', source: 'api', ruleId },
        catchAll: { target: 'external', fresh: true, live: true }
      },
      recommendedPolicy: 'retain_reject_route',
      canConfirm: true
    });
    expect(provider.calls.every((call) => call.startsWith('GET '))).toBe(true);
    expect(database.query('SELECT lifecycle_status, receive_enabled FROM mail_addresses WHERE id = ?').get(addressId))
      .toEqual({ lifecycle_status: 'active', receive_enabled: 1 });
  });

  test('DELETE with retain policy leaves the exact remote rule untouched and persists the policy', async () => {
    const { database, env } = fixture();
    const provider = cloudflareMock();
    const response = await DELETE(event(env, 'DELETE', { confirm: 'delete', policy: 'retain_reject_route' }));
    const payload = await response.json() as { data: { remoteRuleStatus: string; remoteRulePreserved: boolean; deleteRoutePolicy: string } };

    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({
      remoteRuleStatus: 'retained_for_rejection', remoteRulePreserved: true, deleteRoutePolicy: 'retain_reject_route'
    });
    expect(provider.calls.filter((call) => call.startsWith('DELETE '))).toEqual([]);
    expect(database.query('SELECT lifecycle_status, routing_state, routing_owner, delete_route_policy, receive_enabled FROM mail_addresses WHERE id = ?').get(addressId))
      .toEqual({ lifecycle_status: 'deleted', routing_state: 'active', routing_owner: 'flaremail', delete_route_policy: 'retain_reject_route', receive_enabled: 0 });
  });

  test('does not query Cloudflare for an unauthenticated preview', async () => {
    const { env } = fixture();
    const provider = cloudflareMock();
    const response = await getDeletePreview(event(env, 'GET', undefined, false));
    expect(response.status).toBe(401);
    expect(provider.calls).toEqual([]);
  });
});
