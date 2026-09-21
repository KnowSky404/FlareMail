import { describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import type { CloudflareEmailRoutingRule } from '$lib/server/cloudflare-email-routing';
import { checkManagedMailDomain, type ManagedMailDomainCheckDependencies } from './check';
import { disableManagedMailAddress } from './routing';

const schema = readFileSync(resolve(import.meta.dir, '../../../../schema.sql'), 'utf8');
const ownerId = 'owner-0000-0000-0000-000000000001';
const domainId = 'domain-0000-0000-0000-000000000001';
const zoneId = 'a'.repeat(32);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class SqliteD1Statement {
  private values: SQLQueryBindings[] = [];

  constructor(private readonly database: Database, readonly sql: string) {}

  bind(...values: SQLQueryBindings[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    return this.database.query(this.sql).get(...this.values) as T | null;
  }

  async all<T>() {
    return { results: this.database.query(this.sql).all(...this.values) as T[] };
  }

  runNow() {
    return this.database.query(this.sql).run(...this.values);
  }

  async run() {
    const result = this.runNow();
    return { success: true, meta: { changes: result.changes } };
  }
}

function createFixture() {
  const sqlite = new Database(':memory:');
  sqlite.exec(schema);
  sqlite.query('INSERT INTO workspace_users (id, name, role) VALUES (?, ?, ?)').run(ownerId, 'Owner', 'owner');
  sqlite.query('INSERT INTO workspace_owner (singleton, user_id) VALUES (1, ?)').run(ownerId);
  sqlite.query(`
    INSERT INTO mail_domains (id, owner_user_id, domain_name, cloudflare_zone_id, worker_name)
    VALUES (?, ?, 'mail.example.test', ?, 'flaremail-worker')
  `).run(domainId, ownerId, zoneId);
  const insertAddress = sqlite.query(`
    INSERT INTO mail_addresses (
      id, owner_user_id, domain_id, email, local_part, lifecycle_status,
      routing_state, routing_rule_id, routing_rule_source, routing_owner, receive_enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertAddress.run('address-managed-0000000000000001', ownerId, domainId, 'managed@mail.example.test', 'managed', 'active', 'unknown', 'rule-managed', 'api', 'flaremail', 0);
  insertAddress.run('address-imported-0000000000000002', ownerId, domainId, 'imported@mail.example.test', 'imported', 'active', 'unknown', 'rule-imported', 'wrangler', 'imported', 0);
  insertAddress.run('address-importable-0000000000000003', ownerId, domainId, 'importable@mail.example.test', 'importable', 'active', 'pending', null, null, null, 0);
  insertAddress.run('address-conflict-0000000000000004', ownerId, domainId, 'conflict@mail.example.test', 'conflict', 'active', 'pending', null, null, null, 0);
  insertAddress.run('address-missing-0000000000000005', ownerId, domainId, 'missing@mail.example.test', 'missing', 'active', 'unknown', null, null, null, 0);
  insertAddress.run('address-deleted-0000000000000006', ownerId, domainId, 'deleted@mail.example.test', 'deleted', 'deleted', 'deleting', 'rule-deleted', 'api', 'flaremail', 0);
  const db = {
    prepare(sql: string) {
      return new SqliteD1Statement(sqlite, sql);
    },
    async batch(statements: SqliteD1Statement[]) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.runNow());
        sqlite.exec('COMMIT');
        return results.map((result) => ({ success: true, meta: { changes: result.changes } }));
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  } as unknown as D1Database;
  const env = {
    DB: db,
    CLOUDFLARE_EMAIL_ROUTING_TOKEN: 'routing-secret',
    RESEND_API_KEY: 'resend-secret'
  } as CloudflareEnv;
  const selectAddress = (id: string) => sqlite.query(
    'SELECT lifecycle_status, routing_state, routing_rule_id, routing_rule_source, routing_owner, receive_enabled, send_enabled, operation_token, operation_expires_at, last_error_code FROM mail_addresses WHERE id = ?'
  ).get(id) as Record<string, unknown>;
  const selectDomain = () => sqlite.query(
    'SELECT cloudflare_account_id, catch_all_target, catch_all_checked_at, cloudflare_checked_at, resend_domain_id, resend_status, resend_sending_status FROM mail_domains WHERE id = ?'
  ).get(domainId) as Record<string, unknown>;
  return { sqlite, env, selectAddress, selectDomain };
}

function rule(
  id: string,
  email: string,
  options: { source?: 'api' | 'wrangler'; name?: string; type?: string; value?: string } = {}
): CloudflareEmailRoutingRule {
  const source = options.source ?? 'api';
  return {
    id,
    name: options.name ?? '',
    enabled: true,
    source,
    matchers: [{ type: 'literal', field: 'to', value: email }],
    actions: [{ type: options.type ?? 'worker', value: [options.value ?? 'flaremail-worker'] }]
  };
}

function dependencies(rules: CloudflareEmailRoutingRule[], options: {
  cfError?: boolean;
  beforeList?: () => Promise<void>;
  now?: () => string;
  randomUUID?: () => string;
} = {}) {
  const deps: ManagedMailDomainCheckDependencies = {
    cloudflareClient: {
      async getZone(zone) {
        expect(zone).toBe(zoneId);
        return { id: zoneId, name: 'example.test', accountId: 'account-1' };
      },
      async listRules() {
        if (options.cfError) throw new Error('private provider response');
        await options.beforeList?.();
        return rules;
      },
      async getCatchAll() {
        return { enabled: true, actions: [{ type: 'worker', value: ['flaremail-worker'] }] };
      }
    },
    async resendLookup(_key, exactDomain) {
      expect(exactDomain).toBe('mail.example.test');
      return { id: 'resend-domain-1', name: exactDomain, status: 'verified', verified: true, sendingEnabled: true };
    },
    now: options.now ?? (() => '2026-09-20T12:00:00.000Z'),
    ...(options.randomUUID ? { randomUUID: options.randomUUID } : {})
  };
  return deps;
}

describe('managed mail domain checks', () => {
  test('reconciles exact address routes and checks both services without remote mutation', async () => {
    const fixture = createFixture();
    const rules = [
      rule('rule-managed', 'managed@mail.example.test', { name: 'FlareMail managed address address-managed-0000000000000001' }),
      rule('rule-imported', 'imported@mail.example.test', { source: 'wrangler' }),
      rule('rule-importable', 'importable@mail.example.test'),
      rule('rule-conflict', 'conflict@mail.example.test', { type: 'forward', value: 'outside@example.net' }),
      rule('rule-deleted', 'deleted@mail.example.test', { name: 'FlareMail managed address address-deleted-0000000000000006' })
    ];
    const result = await checkManagedMailDomain(fixture.env, ownerId, domainId, dependencies(rules));
    expect(result.cloudflare).toMatchObject({
      state: 'ready',
      zoneName: 'example.test',
      catchAllEnabled: true,
      catchAllTarget: 'this_worker',
      addresses: [
        { email: 'conflict@mail.example.test', status: 'conflict' },
        { email: 'deleted@mail.example.test', status: 'deleted_route' },
        { email: 'importable@mail.example.test', status: 'importable' },
        { email: 'imported@mail.example.test', status: 'imported' },
        { email: 'managed@mail.example.test', status: 'managed' },
        { email: 'missing@mail.example.test', status: 'missing' },
      ]
    });
    expect(result.resend).toMatchObject({ state: 'verified', sendingEnabled: true });
    expect(fixture.selectAddress('address-managed-0000000000000001')).toMatchObject({ routing_state: 'active', receive_enabled: 0, routing_owner: 'flaremail' });
    expect(fixture.selectAddress('address-imported-0000000000000002')).toMatchObject({ routing_state: 'imported', receive_enabled: 0, routing_owner: 'imported' });
    expect(fixture.selectAddress('address-importable-0000000000000003')).toMatchObject({ routing_state: 'pending', receive_enabled: 0 });
    expect(fixture.selectAddress('address-conflict-0000000000000004')).toMatchObject({ routing_state: 'error', receive_enabled: 0 });
    expect(fixture.selectAddress('address-deleted-0000000000000006')).toMatchObject({
      routing_state: 'error', receive_enabled: 0, last_error_code: 'cloudflare_deleted_address_route_present'
    });
    expect(fixture.selectDomain()).toMatchObject({
      cloudflare_account_id: 'account-1',
      catch_all_target: 'this_worker',
      cloudflare_checked_at: '2026-09-20T12:00:00.000Z',
      resend_domain_id: 'resend-domain-1',
      resend_status: 'verified',
      resend_sending_status: 'enabled'
    });
    fixture.sqlite.close();
  });

  test('route observations preserve the Owner receive switches for active addresses', async () => {
    const fixture = createFixture();
    fixture.sqlite.query(`UPDATE mail_addresses SET receive_enabled = 1 WHERE id IN (?, ?)`)
      .run('address-managed-0000000000000001', 'address-imported-0000000000000002');
    await checkManagedMailDomain(fixture.env, ownerId, domainId, dependencies([
      rule('rule-managed', 'managed@mail.example.test', { name: 'FlareMail managed address address-managed-0000000000000001' }),
      rule('rule-imported', 'imported@mail.example.test', { source: 'wrangler' })
    ]));
    expect(fixture.selectAddress('address-managed-0000000000000001')).toMatchObject({ routing_state: 'active', receive_enabled: 1 });
    expect(fixture.selectAddress('address-imported-0000000000000002')).toMatchObject({ routing_state: 'imported', receive_enabled: 1 });
    fixture.sqlite.close();
  });

  test('a repeated manual check does not issue provider reads while the current lease is held', async () => {
    const fixture = createFixture();
    let release!: () => void;
    let entered!: () => void;
    const blocking = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    let cloudflareCalls = 0;
    let resendCalls = 0;
    const deps = dependencies([], { beforeList: async () => { cloudflareCalls += 1; entered(); await blocking; } });
    const originalLookup = deps.resendLookup;
    deps.resendLookup = async (...args) => { resendCalls += 1; return originalLookup(...args); };
    const first = checkManagedMailDomain(fixture.env, ownerId, domainId, deps);
    await reached;
    const second = await checkManagedMailDomain(fixture.env, ownerId, domainId, deps);
    expect(second.cloudflare.errorCode).toBe('cloudflare_check_in_progress');
    expect(second.resend.errorCode).toBe('resend_check_in_progress');
    expect(cloudflareCalls).toBe(1);
    expect(resendCalls).toBe(0);
    release();
    await first;
    expect(resendCalls).toBe(1);
    fixture.sqlite.close();
  });

  test('reports Cloudflare failures safely while checking Resend independently', async () => {
    const fixture = createFixture();
    const result = await checkManagedMailDomain(fixture.env, ownerId, domainId, dependencies([], { cfError: true }));
    expect(result.cloudflare).toMatchObject({ state: 'error', errorCode: 'cloudflare_check_failed' });
    expect(result.resend.state).toBe('verified');
    expect(JSON.stringify(result)).not.toContain('private provider response');
    expect(fixture.selectDomain()).toMatchObject({ resend_status: 'verified', resend_sending_status: 'enabled' });
    expect(fixture.selectAddress('address-managed-0000000000000001')).toMatchObject({
      routing_state: 'unknown', receive_enabled: 0, operation_token: null
    });
    fixture.sqlite.close();
  });

  test('keeps a deleted tombstone terminal across repeated checks when its managed route is absent', async () => {
    const fixture = createFixture();
    const deps = dependencies([]);
    const first = await checkManagedMailDomain(fixture.env, ownerId, domainId, deps);
    expect(first.cloudflare.addresses.find((entry) => entry.addressId === 'address-deleted-0000000000000006'))
      .toMatchObject({ status: 'deleted_absent' });
    expect(fixture.selectAddress('address-deleted-0000000000000006')).toMatchObject({
      lifecycle_status: 'deleted', routing_state: 'deleted', routing_rule_id: null, receive_enabled: 0
    });

    const second = await checkManagedMailDomain(fixture.env, ownerId, domainId, deps);
    expect(second.cloudflare.addresses.find((entry) => entry.addressId === 'address-deleted-0000000000000006'))
      .toMatchObject({ status: 'deleted_absent' });
    expect(fixture.selectAddress('address-deleted-0000000000000006')).toMatchObject({
      lifecycle_status: 'deleted', routing_state: 'deleted', last_error_code: null
    });
    fixture.sqlite.close();
  });

  test('recognizes a deleted imported rule as an expected preserved result', async () => {
    const fixture = createFixture();
    fixture.sqlite.query(`
      UPDATE mail_addresses SET lifecycle_status = 'deleted', routing_state = 'imported', receive_enabled = 0
      WHERE id = 'address-imported-0000000000000002'
    `).run();
    const rules = [rule('rule-imported', 'imported@mail.example.test', { source: 'wrangler' })];
    const result = await checkManagedMailDomain(fixture.env, ownerId, domainId, dependencies(rules));
    expect(result.cloudflare.addresses.find((entry) => entry.addressId === 'address-imported-0000000000000002'))
      .toMatchObject({ status: 'imported_preserved' });
    expect(fixture.selectAddress('address-imported-0000000000000002')).toMatchObject({
      lifecycle_status: 'deleted', routing_state: 'imported', routing_owner: 'imported', receive_enabled: 0, last_error_code: null
    });
    fixture.sqlite.close();
  });

  test('does not re-enable receiving for a lifecycle-disabled address during a healthy route check', async () => {
    const fixture = createFixture();
    fixture.sqlite.query(`
      UPDATE mail_addresses SET lifecycle_status = 'disabled', receive_enabled = 0
      WHERE id = 'address-managed-0000000000000001'
    `).run();
    const rules = [rule('rule-managed', 'managed@mail.example.test', {
      name: 'FlareMail managed address address-managed-0000000000000001'
    })];
    await checkManagedMailDomain(fixture.env, ownerId, domainId, dependencies(rules));
    expect(fixture.selectAddress('address-managed-0000000000000001')).toMatchObject({
      lifecycle_status: 'disabled', routing_state: 'active', receive_enabled: 0, send_enabled: 0
    });
    fixture.sqlite.close();
  });

  test('discards a late check result after a lease-expired disable takes over', async () => {
    const fixture = createFixture();
    let clock = Date.parse('2026-09-21T12:00:00.000Z');
    const listStarted = deferred<void>();
    const finishList = deferred<void>();
    const rules = [rule('rule-managed', 'managed@mail.example.test', {
      name: 'FlareMail managed address address-managed-0000000000000001'
    })];
    const check = checkManagedMailDomain(fixture.env, ownerId, domainId, dependencies(rules, {
      now: () => new Date(clock).toISOString(),
      async beforeList() {
        listStarted.resolve();
        await finishList.promise;
      }
    }));
    await listStarted.promise;
    clock += 6 * 60 * 1000;
    await disableManagedMailAddress(fixture.env, ownerId, 'address-managed-0000000000000001', { now: () => new Date(clock) });
    finishList.resolve();
    const result = await check;

    expect(result.cloudflare.addresses.find((entry) => entry.addressId === 'address-managed-0000000000000001'))
      .toMatchObject({ status: 'busy' });
    expect(fixture.selectAddress('address-managed-0000000000000001')).toMatchObject({
      lifecycle_status: 'disabled', routing_state: 'unknown', receive_enabled: 0, send_enabled: 0, operation_token: null
    });
    fixture.sqlite.close();
  });

  test('never treats a different or disabled catch-all target as Worker collection', async () => {
    const fixture = createFixture();
    const deps = dependencies([]);
    deps.cloudflareClient.getZone = async () => ({ id: zoneId, name: 'example.test', accountId: null });
    deps.cloudflareClient.getCatchAll = async () => ({ enabled: false, actions: [] });
    const result = await checkManagedMailDomain(fixture.env, ownerId, domainId, deps);
    expect(result.cloudflare.catchAllTarget).toBe('none');
    expect(fixture.selectDomain()).toMatchObject({ catch_all_target: 'none' });
    fixture.sqlite.close();
  });

  test('fails closed when the configured domain does not belong to its explicit zone', async () => {
    const fixture = createFixture();
    const deps = dependencies([]);
    deps.cloudflareClient.getZone = async () => ({ id: zoneId, name: 'unrelated.test', accountId: 'account-1' });
    const result = await checkManagedMailDomain(fixture.env, ownerId, domainId, deps);
    expect(result.cloudflare).toMatchObject({ state: 'error', errorCode: 'cloudflare_zone_mapping_conflict' });
    expect(fixture.selectDomain().catch_all_checked_at).toBeNull();
    fixture.sqlite.close();
  });
});
