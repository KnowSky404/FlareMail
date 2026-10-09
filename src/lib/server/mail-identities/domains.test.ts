import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { CloudflareEmailRoutingError } from '$lib/server/cloudflare-email-routing';
import { domainOnboardingConfiguration, enrollMailDomain, updateMailDomain } from './domains';

const databases: Database[] = [];
const owner = 'owner-1';
const zoneId = 'a'.repeat(32);
const accountId = 'b'.repeat(32);

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private db: Database, private sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this; }
  async first<T>() { return this.db.query(this.sql).get(...this.values) as T | null; }
  async run() { return { success: true, meta: { changes: this.db.query(this.sql).run(...this.values).changes } }; }
}

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
  const env = { DB: { prepare: (sql: string) => new Statement(db, sql) },
    MAIL_IDENTITY_WORKER_NAME: 'flaremail', MAIL_IDENTITY_ACCOUNT_ID: accountId,
    CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN: 'read-token' } as unknown as CloudflareEnv;
  const client = { getZone: async () => ({ id: zoneId, name: 'example.com', accountId }) };
  return { db, env, client };
}

afterEach(() => { while (databases.length) databases.pop()?.close(); });

describe('domain enrollment and settings', () => {
  test('enrolls a verified subdomain with a fixed Worker and rejecting policy, and reconciles repeat requests', async () => {
    const { db, env, client } = fixture();
    const first = await enrollMailDomain(env, owner, { domainName: ' MAIL.Example.com. ', zoneId }, client);
    expect(first.created).toBe(true);
    expect(first.domain).toMatchObject({ domain_name: 'mail.example.com', worker_name: 'flaremail', unknown_recipient_policy: 'reject', cloudflare_account_id: accountId });
    const repeat = await enrollMailDomain(env, owner, { domainName: 'mail.example.com', zoneId }, client);
    expect(repeat).toMatchObject({ created: false, domain: { id: first.domain.id } });
    expect(db.query('SELECT COUNT(*) AS count FROM mail_domains').get()).toEqual({ count: 1 });
  });

  test('rejects mismatched domains, returned zone IDs, missing accounts, and foreign accounts without inserting rows', async () => {
    const { db, env, client } = fixture();
    for (const provider of [client,
      { getZone: async () => ({ id: 'c'.repeat(32), name: 'attackerexample.com', accountId }) },
      { getZone: async () => ({ id: zoneId, name: 'attackerexample.com', accountId: null }) },
      { getZone: async () => ({ id: zoneId, name: 'attackerexample.com', accountId: 'c'.repeat(32) }) }]) {
      await expect(enrollMailDomain(env, owner, { domainName: 'attackerexample.com', zoneId }, provider))
        .rejects.toMatchObject({ code: 'MAIL_DOMAIN_ZONE_MISMATCH' });
    }
    expect(db.query('SELECT COUNT(*) AS count FROM mail_domains').get()).toEqual({ count: 0 });
  });

  test('fails closed for missing deployment configuration and provider permission errors', async () => {
    const { env } = fixture();
    expect(domainOnboardingConfiguration({ ...env, MAIL_IDENTITY_ACCOUNT_ID: '' })).toMatchObject({ available: false });
    await expect(enrollMailDomain({ ...env, CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN: '' }, owner, { domainName: 'example.com', zoneId }))
      .rejects.toMatchObject({ code: 'MAIL_DOMAIN_ONBOARDING_NOT_CONFIGURED' });
    await expect(enrollMailDomain(env, owner, { domainName: 'example.com', zoneId }, {
      getZone: async () => { throw new CloudflareEmailRoutingError('permission_denied'); }
    })).rejects.toMatchObject({ status: 403, code: 'MAIL_DOMAIN_ZONE_CHECK_FAILED', retryable: false });
  });

  test('does not replace an existing mapping or cross Owner boundaries', async () => {
    const { env, client } = fixture();
    const input = { domainName: 'example.com', zoneId };
    const first = await enrollMailDomain(env, owner, input, client);
    await expect(enrollMailDomain(env, 'other-owner', input, client)).rejects.toMatchObject({ code: 'MAIL_DOMAIN_ALREADY_CONFIGURED' });
    await expect(enrollMailDomain({ ...env, MAIL_IDENTITY_WORKER_NAME: 'another-worker' }, owner, input, client))
      .rejects.toMatchObject({ code: 'MAIL_DOMAIN_ALREADY_CONFIGURED' });
    await expect(updateMailDomain(env, 'other-owner', first.domain.id, { enabled: false }))
      .rejects.toMatchObject({ code: 'MAIL_DOMAIN_NOT_FOUND' });
  });

  test('gates collect on fresh verified catch-all and preserves addresses while disabling a domain', async () => {
    const { db, env, client } = fixture();
    const { domain } = await enrollMailDomain(env, owner, { domainName: 'example.com', zoneId }, client);
    db.query(`INSERT INTO mail_addresses (id, owner_user_id, domain_id, email, local_part, receive_enabled, send_enabled)
      VALUES ('address-1', ?, ?, 'hello@example.com', 'hello', 1, 1)`).run(owner, domain.id);
    await expect(updateMailDomain(env, owner, domain.id, { unknownRecipientPolicy: 'collect' }))
      .rejects.toMatchObject({ code: 'MAIL_DOMAIN_COLLECT_NOT_READY' });
    db.query(`UPDATE mail_domains SET catch_all_target = 'this_worker', catch_all_checked_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), domain.id);
    expect(await updateMailDomain(env, owner, domain.id, { unknownRecipientPolicy: 'collect' })).toMatchObject({ unknown_recipient_policy: 'collect' });
    db.query(`UPDATE mail_domains SET catch_all_checked_at = '2000-01-01T00:00:00Z' WHERE id = ?`).run(domain.id);
    expect(await updateMailDomain(env, owner, domain.id, { enabled: false, unknownRecipientPolicy: 'collect' })).toMatchObject({ enabled: 0 });
    expect(db.query('SELECT receive_enabled, send_enabled FROM mail_addresses').get()).toEqual({ receive_enabled: 1, send_enabled: 1 });
  });
});
