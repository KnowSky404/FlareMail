import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { CloudflareEmailRoutingError, type CloudflareEmailRoutingRule } from '$lib/server/cloudflare-email-routing';
import { syncCloudflareMailIdentities } from './sync';

const owner = 'owner-1';
const zoneId = 'a'.repeat(32);
const accountId = 'b'.repeat(32);
const databases: Database[] = [];
class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private db: Database, private sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this; }
  async first<T>() { return this.db.query(this.sql).get(...this.values) as T | null; }
  async run() { return { success: true, meta: { changes: this.db.query(this.sql).run(...this.values).changes } }; }
}
function rule(email = 'support@example.com', worker = 'flaremail', enabled = true, id = 'rule-1'): CloudflareEmailRoutingRule {
  return { id, name: 'Existing dashboard route', enabled, source: 'api',
    matchers: [{ type: 'literal', field: 'to', value: email }], actions: [{ type: 'worker', value: [worker] }] };
}
function fixture(rules = [rule()], collect = false) {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
  db.query('INSERT INTO workspace_owner (singleton, user_id) VALUES (1, ?)').run(owner);
  const env = { DB: { prepare: (sql: string) => new Statement(db, sql) }, MAIL_IDENTITY_WORKER_NAME: 'flaremail',
    MAIL_IDENTITY_ACCOUNT_ID: accountId, CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN: 'read-token' } as unknown as CloudflareEnv;
  const client = {
    listZones: async () => [{ id: zoneId, name: 'example.com', accountId }],
    listRules: async () => rules,
    getCatchAll: async () => ({ enabled: true, actions: [{ type: 'worker', value: [collect ? 'flaremail' : 'another-app'] }] })
  };
  return { db, env, client };
}
afterEach(() => { while (databases.length) databases.pop()?.close(); });

describe('Cloudflare mail identity discovery', () => {
  test('imports existing Worker addresses without taking ownership or enabling sending, and records an external catch-all', async () => {
    const { db, env, client } = fixture([rule(), rule('disabled@mail.example.com', 'flaremail', false, 'rule-2'), rule('other@example.com', 'other-worker')]);
    expect(await syncCloudflareMailIdentities(env, owner, client)).toMatchObject({ domainsCreated: 2, addressesCreated: 2, skippedRules: 1, warnings: [] });
    expect(db.query('SELECT domain_name, unknown_recipient_policy, catch_all_target FROM mail_domains ORDER BY domain_name').all())
      .toEqual([{ domain_name: 'example.com', unknown_recipient_policy: 'reject', catch_all_target: 'external' },
        { domain_name: 'mail.example.com', unknown_recipient_policy: 'reject', catch_all_target: 'unknown' }]);
    expect(db.query('SELECT email, receive_enabled, send_enabled, routing_state, routing_owner FROM mail_addresses ORDER BY email').all())
      .toEqual([{ email: 'disabled@mail.example.com', receive_enabled: 0, send_enabled: 0, routing_state: 'imported', routing_owner: 'imported' },
        { email: 'support@example.com', receive_enabled: 1, send_enabled: 0, routing_state: 'imported', routing_owner: 'imported' }]);
  });
  test('imports a Worker catch-all domain without inventing recipient addresses and preserves subsequent Owner policy changes', async () => {
    const { db, env, client } = fixture([], true);
    expect(await syncCloudflareMailIdentities(env, owner, client)).toMatchObject({ domainsCreated: 1, addressesCreated: 0 });
    expect(db.query('SELECT unknown_recipient_policy, catch_all_target FROM mail_domains').get())
      .toEqual({ unknown_recipient_policy: 'collect', catch_all_target: 'this_worker' });
    db.query("UPDATE mail_domains SET enabled = 0, unknown_recipient_policy = 'reject'").run();
    await syncCloudflareMailIdentities(env, owner, client);
    expect(db.query('SELECT enabled, unknown_recipient_policy FROM mail_domains').get()).toEqual({ enabled: 0, unknown_recipient_policy: 'reject' });
  });
  test('repeat sync preserves IDs, settings, pending operations and deleted addresses', async () => {
    const { db, env, client } = fixture([rule(), rule('deleted@example.com', 'flaremail', true, 'rule-2')]);
    await syncCloudflareMailIdentities(env, owner, client);
    db.query("UPDATE mail_addresses SET display_name = 'Support team', signature = 'Thanks', receive_enabled = 0, send_enabled = 1, operation_token = 'busy', routing_state = 'provisioning' WHERE email = 'support@example.com'").run();
    db.query("UPDATE mail_addresses SET lifecycle_status = 'deleted', deleted_at = '2026-01-01', receive_enabled = 0 WHERE email = 'deleted@example.com'").run();
    const before = db.query('SELECT * FROM mail_addresses ORDER BY email').all();
    expect(await syncCloudflareMailIdentities(env, owner, client)).toMatchObject({ domainsCreated: 0, addressesCreated: 0 });
    expect(db.query('SELECT * FROM mail_addresses ORDER BY email').all()).toEqual(before);
  });
  test('skips duplicate, malformed, foreign-zone and unrelated routes', async () => {
    const { db, env, client } = fixture([rule(), rule('support@example.com', 'other-worker', true, 'duplicate'),
      rule('else@evil-example.com'), rule('bad..local@example.com'), { ...rule(), matchers: [{ type: 'all', field: null, value: null }] }]);
    expect(await syncCloudflareMailIdentities(env, owner, client)).toMatchObject({ domainsCreated: 0, addressesCreated: 0, skippedRules: 5 });
    expect(db.query('SELECT COUNT(*) AS count FROM mail_domains').get()).toEqual({ count: 0 });
  });
  test('never overwrites another Owner or deployment mapping', async () => {
    const { db, env, client } = fixture();
    db.query("INSERT INTO mail_domains (id, owner_user_id, domain_name, cloudflare_zone_id, worker_name) VALUES ('foreign', 'other-owner', 'example.com', ?, 'flaremail')").run(zoneId);
    expect(await syncCloudflareMailIdentities(env, owner, client)).toMatchObject({ addressesCreated: 0, warnings: [{ domainName: 'example.com', code: 'mapping_conflict' }] });
    db.query("UPDATE mail_domains SET owner_user_id = ?, worker_name = 'other-worker'").run(owner);
    expect(await syncCloudflareMailIdentities(env, owner, client)).toMatchObject({ addressesCreated: 0, warnings: [{ domainName: 'example.com', code: 'mapping_conflict' }] });
    expect(db.query('SELECT COUNT(*) AS count FROM mail_addresses').get()).toEqual({ count: 0 });
  });
  test('fails before writing for missing config, non-Owners and invalid account data; safely reports provider errors', async () => {
    const { db, env, client } = fixture();
    await expect(syncCloudflareMailIdentities({ ...env, MAIL_IDENTITY_WORKER_NAME: '' }, owner, client)).rejects.toMatchObject({ code: 'MAIL_DOMAIN_ONBOARDING_NOT_CONFIGURED' });
    await expect(syncCloudflareMailIdentities(env, 'other-owner', client)).rejects.toMatchObject({ status: 403 });
    await expect(syncCloudflareMailIdentities(env, owner, { ...client, listZones: async () => [{ id: zoneId, name: 'example.com', accountId: 'c'.repeat(32) }] })).rejects.toMatchObject({ code: 'MAIL_IDENTITY_DISCOVERY_FAILED' });
    await expect(syncCloudflareMailIdentities(env, owner, { ...client, listZones: async () => { throw new CloudflareEmailRoutingError('permission_denied'); } })).rejects.toMatchObject({ status: 403, retryable: false });
    expect(await syncCloudflareMailIdentities(env, owner, { ...client, listRules: async () => { throw new CloudflareEmailRoutingError('rate_limited'); } }))
      .toMatchObject({ domainsCreated: 0, addressesCreated: 0, warnings: [{ domainName: 'example.com', code: 'rate_limited' }] });
    expect(db.query('SELECT COUNT(*) AS count FROM mail_domains').get()).toEqual({ count: 0 });
  });
});
