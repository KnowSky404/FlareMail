import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { FLAREMAIL_SCHEMA_VERSION } from '$lib/server/db/schema-version';
import { applyResendDeliveryWebhook, reconcilePendingResendEvents } from './delivery';

class TestStatement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly database: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.database.query(this.sql).get(...this.values) as T | null) ?? null; }
  async all<T>() { return { success: true, results: this.database.query(this.sql).all(...this.values) as T[] }; }
  async run<T>() { this.database.query(this.sql).run(...this.values); return { success: true, results: [] as T[] }; }
}

class TestD1 {
  constructor(readonly database: Database) {}
  prepare(sql: string) { return new TestStatement(this.database, sql) as unknown as D1PreparedStatement; }
  async batch(statements: D1PreparedStatement[]) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

const setup = () => {
  const database = new Database(':memory:');
  database.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
  database.query(`INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
    VALUES ('flaremail', ?, '2026-08-19T00:00:00.000Z')`).run(FLAREMAIL_SCHEMA_VERSION);
  database.query(`INSERT INTO workspace_delivery_statuses
    (message_id, user_id, status, attempts, idempotency_key, provider, provider_message_id, submitted_at, last_event, last_event_at)
    VALUES ('message-1', 'user-1', 'submitted', 1, 'flaremail:send:user-1:compose-1', 'resend', 're_1',
      '2027-01-15T08:00:00.000Z', 'submission', '2027-01-15T08:00:00.000Z')`).run();
  database.query(`INSERT INTO workspace_outbound_receipts
    (message_id, user_id, provider, result_kind, remote_status, response_preview, last_event, last_event_at)
    VALUES ('message-1', 'user-1', 'resend', 'accepted', 200, 'submitted', 'submission', '2027-01-15T08:00:00.000Z')`).run();
  const env = { DB: new TestD1(database) as unknown as D1Database, BUCKET: {} as R2Bucket };
  return { database, env };
};

const payload = (type: string, createdAt: string, emailId = 're_1') => ({
  type,
  created_at: createdAt,
  data: { email_id: emailId, to: ['private@example.test'], reason: 'private diagnostic' }
});

describe('Resend delivery reconciliation', () => {
  test('maps delivered to delivered and preserves the persisted request idempotency key', async () => {
    const { database, env } = setup();
    const result = await applyResendDeliveryWebhook(env, 'svix-delivered', payload('email.delivered', '2027-01-15T08:05:00Z'));
    expect(result).toMatchObject({ duplicate: false, ignored: false, matched: true, messageId: 'message-1' });
    expect(database.query(`SELECT status, idempotency_key, delivered_at, last_event FROM workspace_delivery_statuses`).get())
      .toEqual({ status: 'delivered', idempotency_key: 'flaremail:send:user-1:compose-1', delivered_at: '2027-01-15T08:05:00.000Z', last_event: 'email.delivered' });
  });

  test('keeps terminal status during out-of-order events while retaining every event', async () => {
    const { database, env } = setup();
    await applyResendDeliveryWebhook(env, 'svix-delivered', payload('email.delivered', '2027-01-15T08:05:00Z'));
    const delayed = await applyResendDeliveryWebhook(env, 'svix-delayed', payload('email.delivery_delayed', '2027-01-15T08:03:00Z'));
    expect(delayed.ignored).toBe(true);
    expect(database.query(`SELECT status, delivered_at FROM workspace_delivery_statuses`).get())
      .toEqual({ status: 'delivered', delivered_at: '2027-01-15T08:05:00.000Z' });
    expect(database.query(`SELECT COUNT(*) AS count FROM workspace_outbound_events`).get()).toEqual({ count: 2 });
  });

  test('does not move last_event_at backwards for an older event with the same status', async () => {
    const { database, env } = setup();
    await applyResendDeliveryWebhook(env, 'svix-delivered-new', payload('email.delivered', '2027-01-15T08:05:00Z'));
    const older = await applyResendDeliveryWebhook(env, 'svix-delivered-old', payload('email.delivered', '2027-01-15T08:03:00Z'));
    expect(older.ignored).toBe(true);
    expect(database.query(`SELECT status, last_event_at, delivered_at FROM workspace_delivery_statuses`).get())
      .toEqual({ status: 'delivered', last_event_at: '2027-01-15T08:05:00.000Z', delivered_at: '2027-01-15T08:05:00.000Z' });
  });

  test('stores unknown and engagement events without changing delivery state', async () => {
    const { database, env } = setup();
    const unknown = await applyResendDeliveryWebhook(env, 'svix-future', payload('email.future_event', '2027-01-15T08:06:00Z'));
    const opened = await applyResendDeliveryWebhook(env, 'svix-opened', payload('email.opened', '2027-01-15T08:07:00Z'));
    expect(unknown.ignored).toBe(true);
    expect(opened.ignored).toBe(true);
    expect(database.query(`SELECT status, last_event FROM workspace_delivery_statuses`).get())
      .toEqual({ status: 'submitted', last_event: 'submission' });
    const stored = database.query(`SELECT payload_json FROM workspace_outbound_events WHERE svix_id = 'svix-future'`).get() as { payload_json: string };
    expect(stored.payload_json).not.toContain('private@example.test');
    expect(stored.payload_json).not.toContain('private diagnostic');
  });

  test('deduplicates svix ids and stores unmatched provider ids safely', async () => {
    const { database, env } = setup();
    await applyResendDeliveryWebhook(env, 'svix-sent', payload('email.sent', '2027-01-15T08:01:00Z'));
    const duplicate = await applyResendDeliveryWebhook(env, 'svix-sent', payload('email.sent', '2027-01-15T08:01:00Z'));
    const unmatched = await applyResendDeliveryWebhook(env, 'svix-unmatched', payload('email.sent', '2027-01-15T08:02:00Z', 're_unknown'));
    expect(duplicate.duplicate).toBe(true);
    expect(unmatched).toMatchObject({ matched: false, ignored: true });
    expect(database.query(`SELECT COUNT(*) AS count FROM workspace_outbound_events`).get()).toEqual({ count: 2 });
  });

  test('maps suppressed to a terminal suppressed state', async () => {
    const { database, env } = setup();
    await applyResendDeliveryWebhook(env, 'svix-suppressed', payload('email.suppressed', '2027-01-15T08:05:00Z'));
    expect(database.query(`SELECT status, last_error FROM workspace_delivery_statuses`).get())
      .toEqual({ status: 'suppressed', last_error: 'The provider suppressed the message.' });
  });

  test('claims and reconciles a webhook that arrived before provider id persistence', async () => {
    const { database, env } = setup();
    const early = await applyResendDeliveryWebhook(env, 'svix-early', payload('email.delivered', '2027-01-15T08:05:00Z', 're_early'));
    expect(early.matched).toBe(false);
    database.query(`UPDATE workspace_delivery_statuses SET provider_message_id = 're_early' WHERE message_id = 'message-1'`).run();
    const count = await reconcilePendingResendEvents(env, 're_early');
    expect(count).toBe(1);
    expect(database.query(`SELECT status, delivered_at FROM workspace_delivery_statuses`).get())
      .toEqual({ status: 'delivered', delivered_at: '2027-01-15T08:05:00.000Z' });
    expect(database.query(`SELECT message_id, user_id FROM workspace_outbound_events WHERE svix_id = 'svix-early'`).get())
      .toEqual({ message_id: 'message-1', user_id: 'user-1' });
  });
});
