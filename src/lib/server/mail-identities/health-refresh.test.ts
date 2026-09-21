import { describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { CloudflareEmailRoutingError, type CloudflareEmailRoutingRule } from '$lib/server/cloudflare-email-routing';
import { resolveInboundRecipient } from '$lib/server/db/mail-identities';
import { ResendDomainError } from '$lib/server/resend-domains';
import { refreshMailDomainHealth, type MailHealthRefreshDependencies } from './health-refresh';

const schema = readFileSync(resolve(import.meta.dir, '../../../../schema.sql'), 'utf8');
const ownerId = 'health-owner-000000000000000001';
const domainId = 'health-domain-000000000000000001';
const zoneId = 'b'.repeat(32);
const defaultNow = Date.parse('2026-09-21T12:00:00.000Z');

class SqliteStatement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly db: Database, private readonly sql: string) {}
  bind(...values: SQLQueryBindings[]) { this.values = values; return this; }
  async first<T>() { return this.db.query(this.sql).get(...this.values) as T | null; }
  async all<T>() { return { results: this.db.query(this.sql).all(...this.values) as T[] }; }
  async run() {
    const result = this.db.query(this.sql).run(...this.values);
    return { success: true, meta: { changes: result.changes } };
  }
}

function createFixture(options: { due?: boolean; checkedAt?: string | null; collect?: boolean } = {}) {
  const sqlite = new Database(':memory:');
  sqlite.exec(schema);
  sqlite.query('INSERT INTO workspace_users (id, name, role) VALUES (?, ?, ?)').run(ownerId, 'Owner', 'owner');
  sqlite.query('INSERT INTO workspace_owner (singleton, user_id) VALUES (1, ?)').run(ownerId);
  const checkedAt = options.checkedAt ?? null;
  sqlite.query(`
    INSERT INTO mail_domains (
      id, owner_user_id, domain_name, cloudflare_zone_id, cloudflare_account_id, worker_name,
      unknown_recipient_policy, catch_all_target, catch_all_checked_at, cloudflare_checked_at,
      resend_checked_at, cloudflare_next_check_at, resend_next_check_at
    ) VALUES (?, ?, 'mail.example.test', ?, 'account-1', 'flaremail-worker', ?, 'this_worker', ?, ?, ?, ?, ?)
  `).run(
    domainId, ownerId, zoneId, options.collect ? 'collect' : 'reject', checkedAt, checkedAt, checkedAt,
    options.due === false ? new Date(defaultNow + 60_000).toISOString() : null,
    options.due === false ? new Date(defaultNow + 60_000).toISOString() : null
  );
  sqlite.query(`
    INSERT INTO mail_addresses (
      id, owner_user_id, domain_id, email, local_part, lifecycle_status, routing_state,
      routing_rule_id, routing_rule_source, routing_owner, receive_enabled, send_enabled
    ) VALUES ('health-address-000000000000001', ?, ?, 'one@mail.example.test', 'one', 'active', 'active',
      'rule-1', 'api', 'flaremail', 0, 0)
  `).run(ownerId, domainId);
  const db = {
    prepare(sql: string) { return new SqliteStatement(sqlite, sql); }
  } as unknown as D1Database;
  const env = {
    DB: db,
    CLOUDFLARE_EMAIL_ROUTING_TOKEN: 'routing-secret',
    RESEND_API_KEY: 'resend-secret'
  } as CloudflareEnv;
  const readDomain = () => sqlite.query(`
    SELECT catch_all_target, catch_all_checked_at, cloudflare_checked_at,
      cloudflare_next_check_at, cloudflare_check_token, cloudflare_error_code,
      cloudflare_error_at, cloudflare_failure_count, resend_domain_id, resend_status,
      resend_sending_status, resend_checked_at, resend_next_check_at, resend_check_token,
      resend_error_code, resend_error_at, resend_failure_count
    FROM mail_domains WHERE id = ?
  `).get(domainId) as Record<string, unknown>;
  return { sqlite, db, env, readDomain };
}

function managedRule(): CloudflareEmailRoutingRule {
  return {
    id: 'rule-1',
    name: 'FlareMail managed address health-address-000000000000001',
    enabled: true,
    source: 'api',
    matchers: [{ type: 'literal', field: 'to', value: 'one@mail.example.test' }],
    actions: [{ type: 'worker', value: ['flaremail-worker'] }]
  };
}

function successDependencies(nowMs = defaultNow): MailHealthRefreshDependencies {
  return {
    nowMs: () => nowMs,
    randomUUID: () => 'health-lease-token',
    cloudflareClientFactory: () => ({
      async getZone(id) { expect(id).toBe(zoneId); return { id, name: 'example.test', accountId: 'account-1' }; },
      async listRules(id) { expect(id).toBe(zoneId); return [managedRule()]; },
      async getCatchAll(id) { expect(id).toBe(zoneId); return { enabled: true, actions: [{ type: 'worker', value: ['flaremail-worker'] }] }; }
    }),
    async resendLookup(_key, exactDomain, options) {
      expect(exactDomain).toBe('mail.example.test');
      expect(options?.deadlineAt).toBe(nowMs + 10_000);
      return { id: 'resend-id', name: exactDomain, status: 'verified', verified: true, sendingEnabled: true };
    }
  };
}

describe('scheduled mail domain health refresh', () => {
  test('renews due provider observations before the 24-hour inbound window and does not mutate address intent', async () => {
    const checkedAt = new Date(defaultNow - 24 * 60 * 60 * 1000 - 5_000).toISOString();
    const fixture = createFixture({ checkedAt, collect: true });
    const before = await resolveInboundRecipient(fixture.db, 'new@mail.example.test', defaultNow);
    expect(before).toMatchObject({ accepted: false, reason: 'address_unavailable' });

    const calls = { cloudflare: 0, resend: 0, remoteWrites: 0 };
    const deps = successDependencies();
    const createClient = deps.cloudflareClientFactory!;
    deps.cloudflareClientFactory = (...args) => {
      const client = createClient(...args);
      return {
        async getZone(id) { calls.cloudflare += 1; return client.getZone(id); },
        async listRules(id) { calls.cloudflare += 1; return client.listRules(id); },
        async getCatchAll(id) { calls.cloudflare += 1; return client.getCatchAll(id); },
        async deleteRule() { calls.remoteWrites += 1; },
        async createWorkerRule() { calls.remoteWrites += 1; }
      };
    };
    const lookup = deps.resendLookup!;
    deps.resendLookup = async (...args) => { calls.resend += 1; return lookup(...args); };

    const result = await refreshMailDomainHealth(fixture.env, deps);
    expect(result).toMatchObject({
      cloudflare: { state: 'completed', checked: 1 },
      resend: { state: 'completed', checked: 1 }
    });
    expect(calls).toEqual({ cloudflare: 3, resend: 1, remoteWrites: 0 });
    expect(fixture.readDomain()).toMatchObject({
      catch_all_target: 'this_worker',
      catch_all_checked_at: new Date(defaultNow).toISOString(),
      cloudflare_checked_at: new Date(defaultNow).toISOString(),
      resend_checked_at: new Date(defaultNow).toISOString(),
      resend_status: 'verified',
      resend_sending_status: 'enabled',
      cloudflare_error_code: null,
      resend_error_code: null,
      cloudflare_check_token: null,
      resend_check_token: null
    });
    expect(Date.parse(String(fixture.readDomain().cloudflare_next_check_at))).toBeGreaterThan(defaultNow);
    expect(fixture.sqlite.query(`SELECT receive_enabled, send_enabled, lifecycle_status, routing_state FROM mail_addresses`).get())
      .toEqual({ receive_enabled: 0, send_enabled: 0, lifecycle_status: 'active', routing_state: 'active' });
    expect(await resolveInboundRecipient(fixture.db, 'new@mail.example.test', defaultNow))
      .toMatchObject({ accepted: true, recipientStatus: 'unregistered' });

    const repeated = await refreshMailDomainHealth(fixture.env, deps);
    expect(repeated.cloudflare.checked).toBe(0);
    expect(repeated.resend.checked).toBe(0);
    expect(calls.cloudflare).toBe(3);
    expect(calls.resend).toBe(1);
    fixture.sqlite.close();
  });

  test('keeps successful timestamps unchanged on permission and rate-limit errors while checking providers independently', async () => {
    const checkedAt = new Date(defaultNow - 60_000).toISOString();
    const fixture = createFixture({ checkedAt });
    fixture.sqlite.query(`UPDATE mail_addresses SET receive_enabled = 1 WHERE id = 'health-address-000000000000001'`).run();
    const deps = successDependencies();
    deps.cloudflareClientFactory = () => ({
      async getZone() { throw new CloudflareEmailRoutingError('permission_denied'); },
      async listRules() { throw new Error('must not be called'); },
      async getCatchAll() { throw new Error('must not be called'); }
    });
    deps.resendLookup = async () => { throw new ResendDomainError('rate_limited'); };

    const result = await refreshMailDomainHealth(fixture.env, deps);
    expect(result).toMatchObject({ cloudflare: { checked: 1 }, resend: { checked: 1 } });
    expect(fixture.readDomain()).toMatchObject({
      catch_all_checked_at: checkedAt,
      cloudflare_checked_at: checkedAt,
      resend_checked_at: checkedAt,
      cloudflare_error_code: 'cloudflare_permission_denied',
      resend_error_code: 'resend_rate_limited',
      cloudflare_failure_count: 0,
      resend_failure_count: 1
    });
    const row = fixture.readDomain();
    expect(Date.parse(String(row.cloudflare_next_check_at)) - defaultNow).toBeGreaterThan(0);
    expect(Date.parse(String(row.cloudflare_next_check_at)) - defaultNow).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
    expect(Date.parse(String(row.resend_next_check_at)) - defaultNow).toBeLessThan(10 * 60 * 1000);
    expect(await resolveInboundRecipient(fixture.db, 'one@mail.example.test', defaultNow))
      .toMatchObject({ accepted: true, recipientStatus: 'managed' });
    fixture.sqlite.close();
  });

  test('does not advance either successful timestamp on provider timeouts', async () => {
    const checkedAt = new Date(defaultNow - 2 * 60 * 60 * 1000).toISOString();
    const fixture = createFixture({ checkedAt });
    const deps = successDependencies();
    deps.cloudflareClientFactory = () => ({
      async getZone() { throw new CloudflareEmailRoutingError('timeout'); },
      async listRules() { throw new Error('must not be called'); },
      async getCatchAll() { throw new Error('must not be called'); }
    });
    deps.resendLookup = async () => { throw new ResendDomainError('timeout'); };

    await refreshMailDomainHealth(fixture.env, deps);
    expect(fixture.readDomain()).toMatchObject({
      catch_all_checked_at: checkedAt,
      cloudflare_checked_at: checkedAt,
      resend_checked_at: checkedAt,
      cloudflare_error_code: 'cloudflare_timeout',
      resend_error_code: 'resend_timeout',
      cloudflare_failure_count: 1,
      resend_failure_count: 1
    });
    fixture.sqlite.close();
  });

  test('records a successfully observed Resend revocation instead of retaining verified readiness', async () => {
    const checkedAt = new Date(defaultNow - 23 * 60 * 60 * 1000).toISOString();
    const fixture = createFixture({ checkedAt });
    const deps = successDependencies();
    deps.resendLookup = async (_key, exactDomain) => ({
      id: 'resend-id', name: exactDomain, status: 'failed', verified: false, sendingEnabled: false
    });

    await refreshMailDomainHealth(fixture.env, deps);
    expect(fixture.readDomain()).toMatchObject({
      resend_checked_at: new Date(defaultNow).toISOString(),
      resend_status: 'failed',
      resend_sending_status: 'disabled',
      resend_error_code: 'resend_domain_failed',
      resend_failure_count: 0
    });
    fixture.sqlite.close();
  });

  test('does no remote work without provider credentials and leaves the domains due for a later configured run', async () => {
    const fixture = createFixture();
    const calls = { cloudflare: 0, resend: 0 };
    const deps = successDependencies();
    deps.cloudflareClientFactory = () => { calls.cloudflare += 1; throw new Error('unexpected Cloudflare API call'); };
    deps.resendLookup = async () => { calls.resend += 1; throw new Error('unexpected Resend API call'); };
    delete (fixture.env as { CLOUDFLARE_EMAIL_ROUTING_TOKEN?: string }).CLOUDFLARE_EMAIL_ROUTING_TOKEN;
    delete (fixture.env as { RESEND_API_KEY?: string }).RESEND_API_KEY;

    const result = await refreshMailDomainHealth(fixture.env, deps);
    expect(result).toMatchObject({
      cloudflare: { state: 'not_configured', checked: 0 },
      resend: { state: 'not_configured', checked: 0 }
    });
    expect(calls).toEqual({ cloudflare: 0, resend: 0 });
    expect(fixture.readDomain()).toMatchObject({ cloudflare_next_check_at: null, resend_next_check_at: null });
    fixture.sqlite.close();
  });

  test('prefers the read-only Cloudflare token when both health and mutation tokens are configured', async () => {
    const fixture = createFixture();
    (fixture.env as { CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN?: string }).CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN = 'read-only-token';
    let selectedToken = '';
    const deps = successDependencies();
    const makeClient = deps.cloudflareClientFactory!;
    deps.cloudflareClientFactory = (token, startedAt) => {
      selectedToken = token;
      return makeClient(token, startedAt);
    };

    await refreshMailDomainHealth(fixture.env, deps);
    expect(selectedToken).toBe('read-only-token');
    fixture.sqlite.close();
  });

  test('uses independent leases to deduplicate overlapping scheduler invocations', async () => {
    const fixture = createFixture();
    let releaseZone!: (value: { id: string; name: string; accountId: string | null }) => void;
    let entered!: () => void;
    const inZone = new Promise<void>((resolvePromise) => { entered = resolvePromise; });
    const zone = new Promise<{ id: string; name: string; accountId: string | null }>((resolvePromise) => { releaseZone = resolvePromise; });
    let zoneCalls = 0;
    const deps = successDependencies();
    deps.cloudflareClientFactory = () => ({
      getZone() { zoneCalls += 1; entered(); return zone; },
      async listRules() { return [managedRule()]; },
      async getCatchAll() { return { enabled: true, actions: [{ type: 'worker', value: ['flaremail-worker'] }] }; }
    });
    const first = refreshMailDomainHealth(fixture.env, deps);
    await inZone;
    const second = await refreshMailDomainHealth(fixture.env, deps);
    expect(second.cloudflare.checked).toBe(0);
    expect(zoneCalls).toBe(1);
    releaseZone({ id: zoneId, name: 'example.test', accountId: 'account-1' });
    const completed = await first;
    expect(completed.cloudflare.checked).toBe(1);
    fixture.sqlite.close();
  });
});
