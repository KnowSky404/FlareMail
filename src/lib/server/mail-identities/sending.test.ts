import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { updateManagedMailAddressSending } from './sending';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly db: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.db.query(this.sql).get(...this.values) as T | null) ?? null; }
  async all<T>() { return { success: true, results: this.db.query(this.sql).all(...this.values) as T[] }; }
  async run() { this.db.query(this.sql).run(...this.values); return { success: true, results: [] }; }
}

class D1 {
  constructor(readonly database: Database) {}
  prepare(sql: string) { return new Statement(this.database, sql) as unknown as D1PreparedStatement; }
  async batch(statements: D1PreparedStatement[]) { return Promise.all(statements.map((statement) => statement.run())); }
}

const fixture = () => {
  const database = new Database(':memory:');
  database.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
  database.query(`INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence)
    VALUES ('owner-1', 'owner@example.test', 'Owner', 'Owner', 'owner@example.test', '', '', 'UTC', 0, '', 0)`).run();
  database.query(`INSERT INTO mail_domains (
      id, owner_user_id, domain_name, cloudflare_zone_id, worker_name, resend_status, resend_sending_status, resend_checked_at
    ) VALUES ('domain-1', 'owner-1', 'example.test', 'zone-1', 'flaremail', 'verified', 'enabled', ?)`)
    .run(new Date().toISOString());
  const DB = new D1(database);
  return { database, env: { DB } as never };
};

function addAddress(database: Database, id: string, localPart: string, options: { sendEnabled?: number; isDefault?: number } = {}) {
  database.query(`INSERT INTO mail_addresses (
      id, owner_user_id, domain_id, email, local_part, lifecycle_status, send_enabled, is_default_sender
    ) VALUES (?, 'owner-1', 'domain-1', ?, ?, 'active', ?, ?)`)
    .run(id, `${localPart}@example.test`, localPart, options.sendEnabled ?? 0, options.isDefault ?? 0);
}

describe('managed mail address sending controls', () => {
  test('enables, defaults and disables only ready owner addresses', async () => {
    const { database, env } = fixture();
    addAddress(database, 'address-1', 'mail');
    addAddress(database, 'address-2', 'support', { sendEnabled: 1 });

    const enabled = await updateManagedMailAddressSending(env, 'owner-1', 'address-1', 'enable_send');
    expect(enabled?.send_enabled).toBe(1);
    const firstDefault = await updateManagedMailAddressSending(env, 'owner-1', 'address-1', 'make_default');
    expect(firstDefault?.is_default_sender).toBe(1);
    const secondDefault = await updateManagedMailAddressSending(env, 'owner-1', 'address-2', 'make_default');
    expect(secondDefault?.is_default_sender).toBe(1);
    expect(database.query(`SELECT is_default_sender FROM mail_addresses WHERE id = 'address-1'`).get())
      .toEqual({ is_default_sender: 0 });

    const disabled = await updateManagedMailAddressSending(env, 'owner-1', 'address-2', 'disable_send');
    expect(disabled).toMatchObject({ send_enabled: 0, is_default_sender: 0 });
    expect(database.query(`SELECT COUNT(*) AS count FROM workspace_users`).get()).toEqual({ count: 1 });
  });

  test('refuses to enable sending when the exact Resend check is stale', async () => {
    const { database, env } = fixture();
    addAddress(database, 'address-1', 'mail');
    database.query(`UPDATE mail_domains SET resend_checked_at = ? WHERE id = 'domain-1'`)
      .run('2020-01-01T00:00:00.000Z');

    await expect(updateManagedMailAddressSending(env, 'owner-1', 'address-1', 'enable_send'))
      .rejects.toMatchObject({ code: 'MAIL_DOMAIN_SENDING_NOT_READY' });
    expect(database.query(`SELECT send_enabled FROM mail_addresses WHERE id = 'address-1'`).get())
      .toEqual({ send_enabled: 0 });
  });
});
