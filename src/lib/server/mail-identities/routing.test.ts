import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { ApiError } from '$lib/server/http/api';
import {
  CloudflareEmailRoutingError,
  type CloudflareEmailRoutingRule
} from '$lib/server/cloudflare-email-routing';
import {
  createManagedMailAddress,
  deleteManagedMailAddress,
  previewManagedMailAddressDeletion,
  restoreManagedMailAddress,
  retryManagedMailAddress,
  type MailIdentityRoutingDependencies
} from './routing';

const schema = readFileSync(resolve(import.meta.dir, '../../../../schema.sql'), 'utf8');
const ownerId = 'owner-0000-0000-0000-000000000001';
const domainId = 'domain-0000-0000-0000-000000000001';
const addressId = 'address-0000-0000-0000-000000000001';
const zoneId = 'a'.repeat(32);
const email = 'person@mail.example.test';
const workerName = 'flaremail-worker';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class SqliteD1Statement {
  private values: SQLQueryBindings[] = [];

  constructor(
    private readonly database: Database,
    readonly sql: string,
    private readonly shouldFail: (sql: string) => boolean
  ) {}

  bind(...values: SQLQueryBindings[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    return (this.database.query(this.sql).get(...this.values) as T | null) ?? null;
  }

  async all<T>() {
    return { results: this.database.query(this.sql).all(...this.values) as T[] };
  }

  runNow() {
    if (this.shouldFail(this.sql)) throw new Error('synthetic D1 write failure');
    const result = this.database.query(this.sql).run(...this.values);
    return { success: true, meta: { changes: result.changes } };
  }
  async run() { return this.runNow(); }
}

function createFixture(options: { failFinishOnce?: boolean; imported?: boolean } = {}) {
  const sqlite = new Database(':memory:');
  sqlite.exec(schema);
  sqlite.query('INSERT INTO workspace_users (id, name, role) VALUES (?, ?, ?)').run(ownerId, 'Owner', 'owner');
  sqlite.query('INSERT INTO workspace_owner (singleton, user_id) VALUES (1, ?)').run(ownerId);
  sqlite.query(`
    INSERT INTO mail_domains (id, owner_user_id, domain_name, cloudflare_zone_id, worker_name)
    VALUES (?, ?, 'mail.example.test', ?, ?)
  `).run(domainId, ownerId, zoneId, workerName);
  sqlite.query(`
    INSERT INTO mail_addresses (
      id, owner_user_id, domain_id, email, local_part, lifecycle_status, routing_state,
      routing_rule_id, routing_rule_source, routing_owner, receive_enabled
    ) VALUES (?, ?, ?, ?, 'person', 'active', 'active', ?, 'api', ?, 1)
  `).run(addressId, ownerId, domainId, email, options.imported ? 'rule-imported' : 'rule-managed', options.imported ? 'imported' : 'flaremail');
  let failFinish = options.failFinishOnce === true;
  const db = {
    prepare(sql: string) {
      return new SqliteD1Statement(sqlite, sql, (statement) => {
        if (!failFinish || !statement.includes('SET routing_state = ?, routing_rule_id = ?')) return false;
        failFinish = false;
        return true;
      });
    },
    async batch(statements: D1PreparedStatement[]) {
      const results = sqlite.transaction(() => statements.map((statement) =>
        (statement as unknown as SqliteD1Statement).runNow()
      ))();
      return results;
    }
  } as unknown as D1Database;
  const env = { DB: db, CLOUDFLARE_EMAIL_ROUTING_TOKEN: 'test-token' } as CloudflareEnv;
  return {
    sqlite,
    env,
    state() {
      return sqlite.query(`
        SELECT lifecycle_status, routing_state, routing_rule_id, routing_rule_source, routing_owner,
          receive_enabled, send_enabled, operation_token, operation_expires_at, delete_route_policy, last_error_code
        FROM mail_addresses WHERE id = ?
      `).get(addressId) as Record<string, unknown>;
    }
  };
}

function managedRule(options: Partial<CloudflareEmailRoutingRule> = {}): CloudflareEmailRoutingRule {
  return {
    id: 'rule-managed',
    name: 'FlareMail managed address ' + addressId,
    enabled: true,
    source: 'api',
    matchers: [{ type: 'literal', field: 'to', value: email }],
    actions: [{ type: 'worker', value: [workerName] }],
    ...options
  };
}

function harness(initialRules: CloudflareEmailRoutingRule[], options: {
  now?: Date;
  onList?: (count: number, rules: CloudflareEmailRoutingRule[]) => CloudflareEmailRoutingRule[];
  beforeList?: (count: number) => Promise<void>;
  onDelete?: (ruleId: string, rules: CloudflareEmailRoutingRule[]) => void | Promise<void>;
} = {}) {
  let now = options.now ?? new Date('2026-09-21T10:00:00.000Z');
  const rules = structuredClone(initialRules);
  const calls: string[] = [];
  let listCount = 0;
  let tokenCount = 0;
  const provider = {
    async listRules(zone: string) {
      expect(zone).toBe(zoneId);
      listCount += 1;
      calls.push('list');
      await options.beforeList?.(listCount);
      const observed = options.onList?.(listCount, structuredClone(rules)) ?? rules;
      return structuredClone(observed);
    },
    async createWorkerRule() {
      throw new Error('delete test must not create rules');
    },
    async deleteRule(_zone: string, ruleId: string) {
      calls.push('delete:' + ruleId);
      await options.onDelete?.(ruleId, rules);
      const index = rules.findIndex((rule) => rule.id === ruleId);
      if (index >= 0) rules.splice(index, 1);
    }
  };
  const dependencies: MailIdentityRoutingDependencies = {
    cloudflareClient: () => provider,
    now: () => new Date(now),
    randomUUID: () => 'operation-' + (++tokenCount)
  };
  return {
    dependencies,
    calls,
    rules,
    advance(ms: number) { now = new Date(now.getTime() + ms); },
    setRules(next: CloudflareEmailRoutingRule[]) { rules.splice(0, rules.length, ...structuredClone(next)); }
  };
}

async function deleteAddress(fixture: ReturnType<typeof createFixture>, provider: ReturnType<typeof harness>) {
  return deleteManagedMailAddress(fixture.env, ownerId, addressId, provider.dependencies);
}

async function expectConflict(promise: Promise<unknown>, codes = ['CLOUDFLARE_RULE_CHANGED']) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ApiError);
  expect(codes).toContain((error as ApiError).code);
}

describe('managed route deletion ownership', () => {
  test('preserves the rule when its Worker target changed, without calling DELETE', async () => {
    const fixture = createFixture();
    const provider = harness([managedRule({ actions: [{ type: 'worker', value: ['other-worker'] }] })]);
    await expect(deleteAddress(fixture, provider)).rejects.toMatchObject({ code: 'CLOUDFLARE_RULE_CHANGED' });
    expect(provider.calls).toEqual(['list']);
    expect(fixture.state()).toMatchObject({ lifecycle_status: 'deleted', routing_state: 'error', receive_enabled: 0 });
    fixture.sqlite.close();
  });

  test('preserves a managed ID whose matcher, source, name, or ID no longer matches its fingerprint', async () => {
    const cases = [
      managedRule({ matchers: [{ type: 'literal', field: 'to', value: 'other@mail.example.test' }] }),
      managedRule({ source: 'wrangler' }),
      managedRule({ name: 'renamed outside FlareMail' }),
      managedRule({ id: 'different-rule-id' })
    ];
    for (const rule of cases) {
      const fixture = createFixture();
      const provider = harness([rule]);
      await expectConflict(deleteAddress(fixture, provider), ['CLOUDFLARE_RULE_CHANGED', 'CLOUDFLARE_EXTERNAL_RULE_PRESERVED']);
      expect(provider.calls).toEqual(['list']);
      expect(provider.rules).toHaveLength(1);
      fixture.sqlite.close();
    }
  });

  test('preserves duplicate exact rules without calling DELETE', async () => {
    const fixture = createFixture();
    const provider = harness([managedRule(), managedRule({ id: 'second-rule' })]);
    await expect(deleteAddress(fixture, provider)).rejects.toMatchObject({ code: 'CLOUDFLARE_RULE_CHANGED' });
    expect(provider.calls).toEqual(['list']);
    expect(provider.rules).toHaveLength(2);
    fixture.sqlite.close();
  });

  test('re-reads the rule immediately before deletion and preserves an externally changed target', async () => {
    const fixture = createFixture();
    const initial = managedRule();
    const provider = harness([initial], {
      onList(count, rules) {
        if (count === 2) return rules.map((rule) => ({
          ...rule,
          actions: [{ type: 'worker', value: ['replacement-worker'] }]
        }));
        return rules;
      }
    });
    await expect(deleteAddress(fixture, provider)).rejects.toMatchObject({ code: 'CLOUDFLARE_RULE_CHANGED' });
    expect(provider.calls).toEqual(['list', 'list']);
    expect(fixture.state()).toMatchObject({ routing_state: 'error', last_error_code: 'cloudflare_rule_changed' });
    fixture.sqlite.close();
  });

  test('never deletes an imported rule and records the expected preserved outcome', async () => {
    const fixture = createFixture({ imported: true });
    const provider = harness([managedRule({ id: 'rule-imported', source: 'wrangler', name: '' })]);
    const result = await deleteAddress(fixture, provider);
    expect(result.remoteRulePreserved).toBeNull();
    expect(result.remoteRuleStatus).toBe('preserved_unverified');
    expect(provider.calls).toEqual([]);
    expect(fixture.state()).toMatchObject({ lifecycle_status: 'deleted', routing_state: 'imported', routing_owner: 'imported' });
    fixture.sqlite.close();
  });

  test('previews the live route and external catch-all without changing either provider or D1', async () => {
    const fixture = createFixture();
    const provider = harness([managedRule()]);
    const preview = await previewManagedMailAddressDeletion(fixture.env, ownerId, addressId, {
      ...provider.dependencies,
      previewCloudflareClient: () => ({
        async getZone(id) { expect(id).toBe(zoneId); return { id: zoneId, name: 'example.test', accountId: 'account-1' }; },
        async listRules(id) { expect(id).toBe(zoneId); provider.calls.push('preview-list'); return provider.rules; },
        async getCatchAll(id) { expect(id).toBe(zoneId); return { enabled: true, actions: [{ type: 'forward', value: ['outside@example.net'] }] }; }
      }),
      now: () => new Date('2026-09-21T11:00:00.000Z')
    });

    expect(preview).toMatchObject({
      historyRetained: true,
      cloudflare: {
        state: 'verified',
        route: { observation: 'managed_worker', ruleId: 'rule-managed' },
        catchAll: { target: 'external', fresh: true, live: true }
      },
      policies: {
        remove_owned_route: { available: true, action: 'remove_verified_owned_rule' },
        retain_reject_route: { available: true, action: 'keep_verified_worker_rule_for_tombstone_rejection' }
      },
      recommendedPolicy: 'retain_reject_route',
      canConfirm: true
    });
    expect(provider.calls).toEqual(['preview-list']);
    expect(fixture.state()).toMatchObject({ lifecycle_status: 'active', routing_state: 'active', receive_enabled: 1 });
    fixture.sqlite.close();
  });

  test('can retain a verified FlareMail rule as a tombstone rejection route', async () => {
    const fixture = createFixture();
    const provider = harness([managedRule()]);
    const result = await deleteManagedMailAddress(
      fixture.env, ownerId, addressId, provider.dependencies, 'retain_reject_route'
    );

    expect(provider.calls).toEqual(['list', 'list']);
    expect(fixture.state()).toMatchObject({
      lifecycle_status: 'deleted', routing_state: 'active', routing_owner: 'flaremail',
      routing_rule_id: 'rule-managed', receive_enabled: 0, send_enabled: 0,
      delete_route_policy: 'retain_reject_route', last_error_code: null
    });
    expect(result).toMatchObject({
      historyRetained: true,
      deleteRoutePolicy: 'retain_reject_route',
      remoteRulePreserved: true,
      remoteRuleStatus: 'retained_for_rejection'
    });
    expect(provider.rules).toHaveLength(1);
    fixture.sqlite.close();
  });

  test('restores a retained reject route without clearing its lease early or creating a duplicate', async () => {
    const fixture = createFixture();
    const provider = harness([managedRule()]);
    await deleteManagedMailAddress(fixture.env, ownerId, addressId, provider.dependencies, 'retain_reject_route');

    const restored = await restoreManagedMailAddress(fixture.env, ownerId, addressId, provider.dependencies);
    expect(provider.calls).toEqual(['list', 'list', 'list']);
    expect(restored).toMatchObject({
      lifecycle_status: 'active', routing_state: 'active', routing_owner: 'flaremail',
      receive_enabled: 1, delete_route_policy: null
    });
    expect(provider.rules).toHaveLength(1);
    fixture.sqlite.close();
  });

  test('keeps the deleted reject-route outcome stable during a read-only route check', async () => {
    const fixture = createFixture();
    const provider = harness([managedRule()]);
    await deleteManagedMailAddress(fixture.env, ownerId, addressId, provider.dependencies, 'retain_reject_route');

    const checked = await import('./check').then(({ checkManagedMailDomain }) =>
      checkManagedMailDomain(fixture.env, ownerId, domainId, {
        cloudflareClient: {
          async getZone(id) { expect(id).toBe(zoneId); return { id: zoneId, name: 'example.test', accountId: null }; },
          async listRules(id) { expect(id).toBe(zoneId); return provider.rules; },
          async getCatchAll() { return { enabled: false, actions: [] }; }
        },
        async resendLookup() { return null; },
        now: () => '2026-09-21T10:01:00.000Z',
        randomUUID: (() => { let count = 0; return () => 'check-operation-' + (++count); })()
      })
    );

    expect(checked.cloudflare.addresses).toContainEqual({
      addressId, email, status: 'reject_route_preserved'
    });
    expect(fixture.state()).toMatchObject({
      lifecycle_status: 'deleted', routing_state: 'active', routing_owner: 'flaremail',
      receive_enabled: 0, delete_route_policy: 'retain_reject_route', last_error_code: null
    });
    fixture.sqlite.close();
  });

  test('recovers a unique managed marker when the create response was not persisted', async () => {
    const fixture = createFixture();
    fixture.sqlite.query(`UPDATE mail_addresses SET routing_rule_id = NULL, routing_rule_source = NULL, routing_owner = NULL WHERE id = ?`).run(addressId);
    const provider = harness([managedRule()]);
    const result = await deleteAddress(fixture, provider);
    expect(result.remoteRulePreserved).toBe(false);
    expect(provider.calls).toEqual(['list', 'list', 'delete:rule-managed', 'list']);
    expect(fixture.state()).toMatchObject({ lifecycle_status: 'deleted', routing_state: 'deleted', routing_rule_id: null });
    fixture.sqlite.close();
  });

  test('reconciles a timed out DELETE that completed remotely without issuing it again', async () => {
    const fixture = createFixture();
    const provider = harness([managedRule()], {
      async onDelete(ruleId, rules) {
        const index = rules.findIndex((rule) => rule.id === ruleId);
        if (index >= 0) rules.splice(index, 1);
        throw new CloudflareEmailRoutingError('timeout');
      }
    });
    const result = await deleteAddress(fixture, provider);
    expect(result.address).toMatchObject({ routing_state: 'deleted', lifecycle_status: 'deleted' });
    expect(provider.calls).toEqual(['list', 'list', 'delete:rule-managed', 'list']);
    fixture.sqlite.close();
  });

  test('recovers after remote deletion succeeded but the local final write failed', async () => {
    const fixture = createFixture({ failFinishOnce: true });
    const provider = harness([managedRule()]);
    await expect(deleteAddress(fixture, provider)).rejects.toThrow('synthetic D1 write failure');
    expect(fixture.state()).toMatchObject({ lifecycle_status: 'deleted', routing_state: 'deleting', operation_token: 'operation-1' });
    expect(provider.calls).toEqual(['list', 'list', 'delete:rule-managed', 'list']);

    provider.advance(6 * 60 * 1000);
    const result = await retryManagedMailAddress(fixture.env, ownerId, addressId, provider.dependencies);
    expect(result).toMatchObject({ address: { routing_state: 'deleted', operation_token: null } });
    expect(provider.calls).toEqual(['list', 'list', 'delete:rule-managed', 'list', 'list']);
    fixture.sqlite.close();
  });

  test('serializes duplicate delete and restore attempts behind the active delete lease', async () => {
    const fixture = createFixture();
    const started = deferred<void>();
    const resume = deferred<void>();
    const provider = harness([managedRule()], {
      async beforeList(count) {
        if (count === 1) {
          started.resolve();
          await resume.promise;
        }
      }
    });
    const deletion = deleteAddress(fixture, provider);
    await started.promise;

    await expectConflict(deleteAddress(fixture, provider), ['MAIL_ADDRESS_OPERATION_CONFLICT']);
    await expectConflict(
      restoreManagedMailAddress(fixture.env, ownerId, addressId, provider.dependencies),
      ['MAIL_ADDRESS_OPERATION_CONFLICT']
    );
    expect(fixture.state()).toMatchObject({
      lifecycle_status: 'deleted', routing_state: 'deleting', operation_token: 'operation-1'
    });

    resume.resolve();
    const result = await deletion;
    expect(result.address).toMatchObject({ lifecycle_status: 'deleted', routing_state: 'deleted', operation_token: null });
    expect(provider.calls).toEqual(['list', 'list', 'delete:rule-managed', 'list']);
    fixture.sqlite.close();
  });

  test('lets a fresh delete take over an expired lease and rejects the old result', async () => {
    const fixture = createFixture();
    const started = deferred<void>();
    const resume = deferred<void>();
    const provider = harness([managedRule()], {
      async beforeList(count) {
        if (count === 1) {
          started.resolve();
          await resume.promise;
        }
      }
    });
    const staleDelete = deleteAddress(fixture, provider);
    await started.promise;
    provider.advance(6 * 60 * 1000);

    const currentDelete = await deleteAddress(fixture, provider);
    expect(currentDelete.address).toMatchObject({ routing_state: 'deleted', lifecycle_status: 'deleted' });
    resume.resolve();
    await expectConflict(staleDelete, ['MAIL_ADDRESS_OPERATION_CONFLICT']);
    expect(provider.calls).toEqual(['list', 'list', 'list', 'delete:rule-managed', 'list']);
    expect(fixture.state()).toMatchObject({
      lifecycle_status: 'deleted', routing_state: 'deleted', operation_token: null, receive_enabled: 0
    });
    fixture.sqlite.close();
  });

  test('serializes creation with deletion so the newly created route cannot outlive a completed delete', async () => {
    const fixture = createFixture();
    const createStarted = deferred<void>();
    const resumeCreate = deferred<void>();
    const rules: CloudflareEmailRoutingRule[] = [];
    const calls: string[] = [];
    const createdEmail = 'new@mail.example.test';
    let createRuleId = '';
    const provider = {
      async listRules() {
        calls.push('list');
        return structuredClone(rules);
      },
      async createWorkerRule(_zone: string, input: { email: string; workerName: string; addressId: string }) {
        calls.push('create');
        createRuleId = 'created-route';
        createStarted.resolve();
        await resumeCreate.promise;
        const created: CloudflareEmailRoutingRule = {
          id: createRuleId,
          name: 'FlareMail managed address ' + input.addressId,
          enabled: true,
          source: 'api',
          matchers: [{ type: 'literal', field: 'to', value: input.email }],
          actions: [{ type: 'worker', value: [input.workerName] }]
        };
        rules.push(created);
        return created;
      },
      async deleteRule(_zone: string, ruleId: string) {
        calls.push('delete:' + ruleId);
        const index = rules.findIndex((rule) => rule.id === ruleId);
        if (index >= 0) rules.splice(index, 1);
      }
    };
    let idCount = 0;
    const dependencies: MailIdentityRoutingDependencies = {
      cloudflareClient: () => provider,
      now: () => new Date('2026-09-21T10:00:00.000Z'),
      randomUUID: () => ['created-address-id', 'create-operation', 'delete-before-create', 'delete-operation'][idCount++] ?? 'operation-extra'
    };
    const creating = createManagedMailAddress(fixture.env, ownerId, {
      domainId,
      address: createdEmail
    }, dependencies);
    await createStarted.promise;

    await expectConflict(
      deleteManagedMailAddress(fixture.env, ownerId, 'created-address-id', dependencies),
      ['MAIL_ADDRESS_OPERATION_CONFLICT']
    );
    expect(calls).toEqual(['list', 'create']);
    resumeCreate.resolve();
    const created = await creating;
    expect(created).toMatchObject({ id: 'created-address-id', routing_state: 'active', receive_enabled: 1, send_enabled: 0 });

    const removed = await deleteManagedMailAddress(fixture.env, ownerId, 'created-address-id', dependencies);
    expect(removed.address).toMatchObject({ lifecycle_status: 'deleted', routing_state: 'deleted' });
    expect(calls).toEqual(['list', 'create', 'list', 'list', 'list', 'delete:created-route', 'list']);
    fixture.sqlite.close();
  });

  test('maps only an email uniqueness violation to already-exists and keeps other D1 writes distinct', async () => {
    for (const scenario of [
      { error: 'UNIQUE constraint failed: mail_addresses.email', expected: 'MAIL_ADDRESS_ALREADY_EXISTS' },
      { error: 'D1 connection unavailable', expected: 'D1_WRITE_FAILED' }
    ]) {
      const fixture = createFixture();
      const originalDb = fixture.env.DB!;
      const db = {
        prepare(sql: string) {
          if (sql.startsWith('INSERT INTO mail_addresses')) {
            return {
              bind() {
                return { async run() { throw new Error(scenario.error); } };
              }
            };
          }
          return originalDb.prepare(sql);
        }
      } as D1Database;
      const env = { ...fixture.env, DB: db } as CloudflareEnv;
      let caught: unknown;
      try {
        await createManagedMailAddress(env, ownerId, { domainId, address: 'new@mail.example.test' }, {
          cloudflareClient: () => { throw new Error('Cloudflare must not be reached'); },
          randomUUID: () => 'new-address-id',
          now: () => new Date('2026-09-21T10:00:00.000Z')
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe(scenario.expected);
      fixture.sqlite.close();
    }
  });
});
