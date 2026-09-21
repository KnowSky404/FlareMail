import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveInboundRecipient } from './mail-identities';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly db: Database, private readonly sql: string) {}
  bind(...values: unknown[]) {
    this.values = values as SQLQueryBindings[];
    return this as unknown as D1PreparedStatement;
  }
  async first<T>() {
    return (this.db.query(this.sql).get(...this.values) as T | null) ?? null;
  }
}

class D1 {
  constructor(readonly db: Database) {}
  prepare(sql: string) {
    return new Statement(this.db, sql) as unknown as D1PreparedStatement;
  }
}

const repositoryRoot = resolve(import.meta.dir, '../../../..');
const migrationsDirectory = join(repositoryRoot, 'migrations');

function makeDatabase() {
  const db = new Database(':memory:');
  for (const file of readdirSync(migrationsDirectory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    db.exec(readFileSync(join(migrationsDirectory, file), 'utf8'));
  }
  db.query('INSERT INTO workspace_owner (singleton, user_id) VALUES (1, ?)').run('owner-1');
  db.query(`
    INSERT INTO mail_domains (
      id, owner_user_id, domain_name, cloudflare_zone_id, worker_name,
      enabled, unknown_recipient_policy, catch_all_target, catch_all_checked_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run('domain-1', 'owner-1', 'one.example.test', 'zone-1', 'flaremail', 'reject', 'unknown', null);
  return db;
}

function insertAddress(db: Database, input: {
  id: string;
  email: string;
  lifecycle?: 'active' | 'disabled' | 'deleted';
  receiving?: number;
  route?: 'pending' | 'active' | 'imported' | 'error';
  owner?: string;
  domain?: string;
}) {
  db.query(`
    INSERT INTO mail_addresses (
      id, owner_user_id, domain_id, email, local_part, lifecycle_status,
      receive_enabled, routing_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id, input.owner ?? 'owner-1', input.domain ?? 'domain-1', input.email,
    input.email.slice(0, input.email.indexOf('@')), input.lifecycle ?? 'active',
    input.receiving ?? 1, input.route ?? 'active'
  );
}

describe('trusted inbound address resolution', () => {
  test('maps explicit enabled addresses to the stable Owner without consulting login or profile addresses', async () => {
    const db = makeDatabase();
    insertAddress(db, { id: 'address-1', email: 'inbox@one.example.test' });
    const route = await resolveInboundRecipient(new D1(db), 'Inbox@One.Example.Test');
    expect(route).toEqual({
      accepted: true,
      recipient: 'inbox@one.example.test',
      ownerUserId: 'owner-1',
      mailDomainId: 'domain-1',
      mailAddressId: 'address-1',
      recipientStatus: 'managed'
    });
    expect(await resolveInboundRecipient(new D1(db), 'login@example.test'))
      .toEqual({ accepted: false, reason: 'unknown_domain' });
    expect(await resolveInboundRecipient(new D1(db), 'profile@one.example.test'))
      .toEqual({ accepted: false, reason: 'address_unavailable' });
    db.close();
  });

  test('blocks disabled, deleted, nonreceiving and not-yet-routed exact addresses before collect policy', async () => {
    const db = makeDatabase();
    db.query(`
      UPDATE mail_domains
      SET unknown_recipient_policy = 'collect', catch_all_target = 'this_worker',
          catch_all_checked_at = '2026-09-20T12:00:00.000Z'
    `).run();
    insertAddress(db, { id: 'disabled', email: 'disabled@one.example.test', lifecycle: 'disabled' });
    insertAddress(db, { id: 'deleted', email: 'deleted@one.example.test', lifecycle: 'deleted', receiving: 0 });
    insertAddress(db, { id: 'pending', email: 'pending@one.example.test', receiving: 0, route: 'pending' });

    for (const address of ['disabled@one.example.test', 'deleted@one.example.test', 'pending@one.example.test']) {
      expect(await resolveInboundRecipient(new D1(db), address, Date.parse('2026-09-20T12:30:00.000Z')))
        .toEqual({ accepted: false, reason: 'address_unavailable' });
    }
    db.close();
  });

  test('collects unknown recipients only when policy and a fresh Worker catch-all check both allow it', async () => {
    const db = makeDatabase();
    db.query(`
      UPDATE mail_domains
      SET unknown_recipient_policy = 'collect', catch_all_target = 'this_worker',
          catch_all_checked_at = '2026-09-20T12:00:00.000Z'
    `).run();
    const now = Date.parse('2026-09-20T12:30:00.000Z');
    expect(await resolveInboundRecipient(new D1(db), 'unlisted@one.example.test', now)).toEqual({
      accepted: true,
      recipient: 'unlisted@one.example.test',
      ownerUserId: 'owner-1',
      mailDomainId: 'domain-1',
      mailAddressId: null,
      recipientStatus: 'unregistered'
    });
    db.query("UPDATE mail_domains SET catch_all_target = 'external'").run();
    expect((await resolveInboundRecipient(new D1(db), 'unlisted@one.example.test', now)).accepted).toBe(false);
    db.query("UPDATE mail_domains SET catch_all_target = 'this_worker', catch_all_checked_at = '2026-09-19T00:00:00.000Z'").run();
    expect((await resolveInboundRecipient(new D1(db), 'unlisted@one.example.test', now)).accepted).toBe(false);
    db.close();
  });

  test('allows only explicitly collected unknown recipients through a bounded transient-check grace', async () => {
    const db = makeDatabase();
    const lastSuccess = '2026-09-19T12:00:00.000Z';
    db.query(`
      UPDATE mail_domains SET unknown_recipient_policy = 'collect', catch_all_target = 'this_worker',
        catch_all_checked_at = ?, cloudflare_error_code = 'cloudflare_timeout',
        cloudflare_error_at = '2026-09-20T12:00:00.000Z'
    `).run(lastSuccess);

    const withinGrace = Date.parse('2026-09-21T11:59:00.000Z');
    expect(await resolveInboundRecipient(new D1(db), 'unlisted@one.example.test', withinGrace))
      .toMatchObject({ accepted: true, recipientStatus: 'unregistered' });
    const pastGrace = Date.parse('2026-09-21T12:00:01.000Z');
    expect(await resolveInboundRecipient(new D1(db), 'unlisted@one.example.test', pastGrace))
      .toEqual({ accepted: false, reason: 'address_unavailable' });

    db.query(`UPDATE mail_domains SET cloudflare_error_code = 'cloudflare_permission_denied'`).run();
    expect(await resolveInboundRecipient(new D1(db), 'unlisted@one.example.test', withinGrace))
      .toEqual({ accepted: false, reason: 'address_unavailable' });

    insertAddress(db, { id: 'tombstone', email: 'old@one.example.test', lifecycle: 'deleted', receiving: 0 });
    expect(await resolveInboundRecipient(new D1(db), 'old@one.example.test', withinGrace))
      .toEqual({ accepted: false, reason: 'address_unavailable' });
    db.close();
  });

  test('fails closed on invalid recipient and a missing stable Owner mapping', async () => {
    const db = makeDatabase();
    expect(await resolveInboundRecipient(new D1(db), 'invalid-address'))
      .toEqual({ accepted: false, reason: 'invalid_recipient' });
    db.query("UPDATE mail_domains SET owner_user_id = 'another-owner'").run();
    await expect(resolveInboundRecipient(new D1(db), 'user@one.example.test')).rejects.toThrow('INBOUND_OWNER_MAPPING_UNAVAILABLE');
    db.close();
  });
});
