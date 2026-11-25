import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { FLAREMAIL_SCHEMA_VERSION } from '$lib/server/db/schema-version';
import { findDeliveryDetailRows, attachMatchedOutboundEvents, upsertOutboundReceipt, upsertOutboundStatus } from '$lib/server/db/deliveries';
import { changeDeliveryAttention, findCurrentDeliveryAttention, getDeliveryAttentionSummary, listDeliveryAttention } from '$lib/server/db/delivery-attention';
import { loadMailboxPage } from './mailbox';
import { parseMailboxQuery } from './mailbox-query';
import { applyResendDeliveryWebhook, reconcileDeferredResendEvents, reconcilePendingResendEvents } from './delivery';

class TestStatement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly database: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.database.query(this.sql).get(...this.values) as T | null) ?? null; }
  async all<T>() { return { success: true, results: this.database.query(this.sql).all(...this.values) as T[] }; }
  execute() {
    const query = this.database.query(this.sql);
    if (/^\s*(?:SELECT|WITH)\b|\bRETURNING id\b/iu.test(this.sql)) return { success: true, results: query.all(...this.values), meta: { changes: 0 } };
    return { success: true, results: [], meta: { changes: query.run(...this.values).changes } };
  }
  async run() { return this.execute(); }
}

class TestD1 {
  beforeBatch?: () => void;
  constructor(readonly database: Database) {}
  prepare(sql: string) { return new TestStatement(this.database, sql) as unknown as D1PreparedStatement; }
  async batch(statements: D1PreparedStatement[]) {
    this.beforeBatch?.();
    return this.database.transaction(() =>
      statements.map((statement) => (statement as unknown as TestStatement).execute()))();
  }
}

const setup = () => {
  const database = new Database(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
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
  addMessage(database, 'message-1');
  const env = { DB: new TestD1(database) as unknown as D1Database, BUCKET: {} as R2Bucket };
  return { database, env };
};

function addMessage(database: Database, id: string, user = 'user-1', address = 'address-a') {
  database.query(`INSERT INTO workspace_messages (id, user_id, folder, from_name, from_email, to_name, to_email,
    sent_at, subject, body, sender_address_id) VALUES (?, ?, 'sent', '', ?, '', '', '2026-01-01', ?, 'private-body', ?)`)
    .run(id, user, `${address}@example.test`, id, address);
}

function addDelivery(database: Database, id: string, status: string, time = '2026-01-01T00:00:00.000Z', user = 'user-1', address?: string) {
  addMessage(database, id, user, address);
  database.query(`INSERT INTO workspace_delivery_statuses (message_id, user_id, status, attempts, last_event_at)
    VALUES (?, ?, ?, 1, ?)`).run(id, user, status, time);
}

const page = (db: D1Database, view: 'pending' | 'history' = 'pending', { limit = 20, cursor = null as string | null } = {}) =>
  listDeliveryAttention(db, 'user-1', { view, kind: null, limit, cursor });
const ref = ({ id, version }: { id: number; version: number }) => ({ id, version });

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

  test('shows unambiguous legacy events for a superseded provider ID without replaying them', async () => {
    const { database, env } = setup();
    for (const id of ['re_legacy', 're_ambiguous']) {
      await applyResendDeliveryWebhook(env, id, payload('email.bounced', '2027-01-15T08:05:00Z', id));
    }
    database.exec(`
      INSERT INTO workspace_delivery_attempts (id, message_id, user_id, attempt_number, provider, provider_message_id, status, started_at)
      VALUES ('old-1', 'message-1', 'user-1', 1, 'resend', 're_legacy', 'submitted', '2027-01-15T08:00:00.000Z'),
        ('old-2', 'message-1', 'user-1', 2, 'resend', 're_ambiguous', 'submitted', '2027-01-15T08:00:00.000Z'),
        ('other', 'message-2', 'user-2', 1, 'resend', 're_ambiguous', 'submitted', '2027-01-15T08:00:00.000Z');
    `);
    await reconcileDeferredResendEvents(env);
    const detail = await findDeliveryDetailRows(env.DB, 'user-1', 'message-1');
    expect(detail.events.map(({ svix_id }) => svix_id)).toEqual(['re_legacy']);
    expect(detail).toMatchObject({ status: 'submitted', receipt: { result_kind: 'accepted' }, attention: null });
  });

  test('creates a terminal webhook receipt before any submission receipt exists', async () => {
    const { database, env } = setup();
    const at = '2027-01-15T08:05:00.000Z';
    database.exec("DELETE FROM workspace_outbound_receipts WHERE message_id = 'message-1'");
    await applyResendDeliveryWebhook(env, 'early-bounce', payload('email.bounced', at));
    const check = async () => expect(await findDeliveryDetailRows(env.DB, 'user-1', 'message-1')).toMatchObject({
      status: 'bounced', receipt: { last_event: 'email.bounced', result_kind: 'permanent_failure' }
    });
    await check();
    await upsertOutboundReceipt(env.DB, {
      messageId: 'message-1', userId: 'user-1', attemptNumber: 1, provider: 'resend', resultKind: 'accepted',
      remoteStatus: 200, responsePreview: '', lastEvent: 'submission', lastEventAt: at, createdAt: at, updatedAt: at
    }).run();
    await check();
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

  test('schedules an unmatched webhook only when its provider ID becomes known during insertion', async () => {
    const { database, env } = setup();
    await applyResendDeliveryWebhook(env, 'system-mail', payload('email.delivered', '2027-01-15T08:04:00Z', 're_system'));
    const d1 = env.DB as unknown as TestD1;
    d1.beforeBatch = () => {
      d1.beforeBatch = undefined;
      database.query("UPDATE workspace_delivery_statuses SET provider_message_id = 're_race' WHERE message_id = 'message-1'").run();
    };
    await applyResendDeliveryWebhook(env, 'confirmed-mail', payload('email.delivered', '2027-01-15T08:05:00Z', 're_race'));
    const pending = database.query(`SELECT svix_id FROM workspace_outbound_events
      WHERE json_extract(payload_json, '$._flaremailDeferred') = 1`).all();
    expect(pending).toEqual([{ svix_id: 'confirmed-mail' }]);
    await reconcileDeferredResendEvents(env);
    expect(database.query("SELECT status FROM workspace_delivery_statuses WHERE message_id = 'message-1'").get()).toEqual({ status: 'delivered' });
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

describe('Owner delivery attention', () => {
  test('counts only actionable sent messages once and paginates safe summaries independently of identity', async () => {
    const { database, env } = setup();
    const db = env.DB;
    for (const status of ['delayed', 'failed', 'bounced', 'complained', 'suppressed']) {
      addDelivery(database, status, status, undefined, 'user-1', 'address-b');
    }
    addDelivery(database, 'stalled', 'submitting');
    addDelivery(database, 'fresh', 'submitting', new Date().toISOString());
    addDelivery(database, 'queued', 'queued');
    addDelivery(database, 'another-owner', 'bounced', undefined, 'owner-2');
    let cursor: string | null = null;
    const found = [];
    do {
      const result = await page(db, 'pending', { limit: 2, cursor });
      expect(result.summary.pendingCount).toBe(6);
      found.push(...result.notices);
      cursor = result.nextCursor;
    } while (cursor);
    expect(new Set(found.map(({ kind }) => kind))).toEqual(new Set([
      'delayed', 'failed', 'bounced', 'complained', 'suppressed', 'stale_submitting'
    ]));
    expect(found).toHaveLength(6);
    expect(JSON.stringify(found)).not.toContain('private-body');
    const issue = found[0]!;
    await expect(changeDeliveryAttention(db, 'owner-2', { action: 'acknowledge', incident: ref(issue) }))
      .rejects.toMatchObject({ status: 404 });
    const first = await page(db, 'pending', { limit: 2 });
    await expect(page(db, 'history', { cursor: first.nextCursor })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    expect((await listDeliveryAttention(db, 'user-1', { view: 'pending', kind: 'bounced', limit: 1, cursor: null })).notices)
      .toEqual([expect.objectContaining({ messageId: 'bounced', kind: 'bounced' })]);

    database.exec(`
      INSERT INTO mail_domains (id, owner_user_id, domain_name, cloudflare_zone_id, worker_name)
        VALUES ('domain-b', 'user-1', 'example.test', 'zone', 'worker');
      INSERT INTO mail_addresses (id, owner_user_id, domain_id, email, local_part)
        VALUES ('address-b', 'user-1', 'domain-b', 'address-b@example.test', 'address-b');
    `);
    const session = { userId: 'user-1', storage: 'd1', profile: { email: 'owner@example.test' } } as const;
    const all = parseMailboxQuery(new URLSearchParams('folder=sent&filter=attention'));
    const scoped = { ...all, identityFilter: { kind: 'address', id: 'address-b' } as const };
    const filtered = await loadMailboxPage(env, session as never, scoped);
    expect(filtered.messages).toHaveLength(5);
    expect(filtered.searchTotal).toBe(5);
    expect(filtered.metrics?.bouncedCount).toBe(1);
    database.close();
  });

  test('keeps webhook duplicates and old events from reopening, and rejects an old confirmation on escalation', async () => {
    const { database, env } = setup();
    const db = env.DB;
    const delayed = payload('email.delivery_delayed', '2027-01-15T08:03:00Z');
    await applyResendDeliveryWebhook(env, 'delayed-1', delayed);
    const incident = (await page(db)).notices[0]!;
    expect(incident.kind).toBe('delayed');
    const oldSnapshot = (await page(db)).summary.snapshot;
    const ack = { action: 'acknowledge', incident: ref(incident) } as const;
    const confirmations = await Promise.all([changeDeliveryAttention(db, 'user-1', ack), changeDeliveryAttention(db, 'user-1', ack)]);
    expect(confirmations.map(({ changed }) => changed)).toEqual([1, 0]);
    expect(confirmations[0].summary.pendingCount).toBe(0);
    expect((await page(db, 'history')).notices[0]).toMatchObject({ state: 'acknowledged', closedAt: null });
    expect((await applyResendDeliveryWebhook(env, 'delayed-1', delayed)).duplicate).toBe(true);
    await applyResendDeliveryWebhook(env, 'delayed-2', payload('email.delivery_delayed', '2027-01-15T08:04:00Z'));
    await applyResendDeliveryWebhook(env, 'older-sent', payload('email.sent', '2027-01-15T08:02:00Z'));
    expect((await page(db)).notices).toEqual([]);
    const race = await Promise.allSettled([
      applyResendDeliveryWebhook(env, 'bounced-1', payload('email.bounced', '2027-01-15T08:05:00Z')),
      changeDeliveryAttention(db, 'user-1', ack)
    ]);
    expect(race[0]).toMatchObject({ status: 'fulfilled', value: { ignored: false } });
    if (race[1].status === 'rejected') expect(race[1].reason).toMatchObject({ status: 409 });
    else expect(race[1].value.changed).toBe(0);
    await expect(changeDeliveryAttention(db, 'user-1', ack)).rejects.toMatchObject({ status: 409 });
    expect((await changeDeliveryAttention(db, 'user-1', { action: 'acknowledge_all', snapshot: oldSnapshot })).changed).toBe(0);
    const bounced = (await page(db)).notices[0]!;
    expect(bounced).toMatchObject({ kind: 'bounced', state: 'open' });
    expect(bounced.id).not.toBe(incident.id);
    expect((await page(db, 'history')).notices[0]).toMatchObject({ kind: 'delayed', state: 'superseded' });
    expect(database.query("SELECT status, attempts, idempotency_key FROM workspace_delivery_statuses").get())
      .toEqual({ status: 'bounced', attempts: 1, idempotency_key: 'flaremail:send:user-1:compose-1' });
    expect(database.query("SELECT COUNT(*) AS count FROM workspace_outbound_events").get()).toEqual({ count: 4 });
    database.close();
  });

  test('records actual recovery, keeps prior failure during retry, and assigns a new version after reopen', async () => {
    const { database, env } = setup();
    const db = env.DB;
    await applyResendDeliveryWebhook(env, 'delayed-1', payload('email.delivery_delayed', '2027-01-15T08:03:00Z'));
    const first = (await page(db)).notices[0]!;
    const ack = { action: 'acknowledge', incident: ref(first) } as const;
    await changeDeliveryAttention(db, 'user-1', ack);
    await changeDeliveryAttention(db, 'user-1', { action: 'reopen', incident: ref(first) });
    const reopened = (await findCurrentDeliveryAttention(db, 'user-1', 'message-1'))!;
    expect(reopened.version).toBeGreaterThan(first.version);
    await expect(changeDeliveryAttention(db, 'user-1', ack)).rejects.toMatchObject({ code: 'ATTENTION_CHANGED' });
    await applyResendDeliveryWebhook(env, 'delivered-1', payload('email.delivered', '2027-01-15T08:05:00Z'));
    expect((await page(db)).notices).toEqual([]);
    expect((await page(db, 'history')).notices[0]).toMatchObject({ state: 'resolved', closedAt: expect.any(String) });
    await expect(changeDeliveryAttention(db, 'user-1', { action: 'reopen', incident: ref(reopened) }))
      .rejects.toMatchObject({ code: 'ATTENTION_CHANGED' });

    addDelivery(database, 'retry', 'failed');
    database.query("UPDATE workspace_delivery_statuses SET status = 'submitting', attempts = 2, last_event_at = ? WHERE message_id = 'retry'")
      .run(new Date().toISOString());
    expect(await findCurrentDeliveryAttention(db, 'user-1', 'retry')).toMatchObject({ kind: 'failed' });
    database.query("UPDATE workspace_delivery_statuses SET status = 'submitted' WHERE message_id = 'retry'").run();
    expect((await page(db, 'history')).notices.find(({ messageId }) => messageId === 'retry'))
      .toMatchObject({ kind: 'failed', state: 'resolved' });
    addDelivery(database, 'stale-retry', 'submitting');
    database.query("UPDATE workspace_delivery_statuses SET status = 'submitted' WHERE message_id = 'stale-retry'").run();
    expect((await page(db, 'history')).notices.find(({ messageId }) => messageId === 'stale-retry'))
      .toMatchObject({ kind: 'stale_submitting', state: 'resolved' });
    database.close();
  });

  test('keeps a stalled attempt visible until its retry stalls or succeeds', async () => {
    const { database, env } = setup();
    const db = env.DB;
    addDelivery(database, 'retried-submission', 'submitting');
    const old = (await page(db)).notices[0]!;
    database.query("UPDATE workspace_delivery_statuses SET attempts = 2, last_event_at = ? WHERE message_id = 'retried-submission'")
      .run(new Date().toISOString());
    expect((await page(db)).notices.map(({ id }) => id)).toEqual([old.id]);

    database.query("UPDATE workspace_delivery_statuses SET last_event_at = '2026-01-02' WHERE message_id = 'retried-submission'").run();
    const current = (await page(db)).notices;
    expect(current).toHaveLength(1);
    expect(current[0].id).not.toBe(old.id);
    expect((await page(db, 'history')).notices.find(({ id }) => id === old.id)?.state).toBe('superseded');

    database.query("UPDATE workspace_delivery_statuses SET status = 'submitted' WHERE message_id = 'retried-submission'").run();
    expect((await page(db)).notices).toEqual([]);
    expect((await page(db, 'history')).notices.find(({ id }) => id === current[0].id)?.state).toBe('resolved');
    database.close();
  });

  test('preserves an unresolved delay until an unaccepted same-key retry has definitive delivery proof', async () => {
    const { database, env } = setup();
    const now = Date.now();
    const at = (second: number) => new Date(now + second * 1000).toISOString();
    await applyResendDeliveryWebhook(env, 'delayed-before-retry', payload('email.delivery_delayed', at(2)));
    database.exec(`
      INSERT INTO workspace_delivery_attempts (id, message_id, user_id, attempt_number, idempotency_key,
        provider, provider_message_id, status, started_at)
      VALUES ('new-attempt', 'message-1', 'user-1', 2, 'flaremail:send:user-1:compose-1', 'resend', NULL,
        'submitting', '${at(3)}');
      UPDATE workspace_delivery_statuses SET status = 'submitting', attempts = 2, last_event = 'submission',
        last_event_at = '${at(3)}' WHERE message_id = 'message-1';
    `);
    const late = await applyResendDeliveryWebhook(env, 'late-before-retry', payload('email.sent', at(4)));
    expect(late).toMatchObject({ matched: true, ignored: true });
    expect(database.query("SELECT status FROM workspace_delivery_statuses WHERE message_id = 'message-1'").get())
      .toEqual({ status: 'submitting' });
    expect(database.query("SELECT state, closed_at FROM workspace_delivery_attention WHERE kind = 'delayed'").get())
      .toEqual({ state: 'open', closed_at: null });
    expect(database.query("SELECT user_id FROM workspace_outbound_events WHERE svix_id = 'late-before-retry'").get())
      .toEqual({ user_id: 'user-1' });

    const delivered = await applyResendDeliveryWebhook(env, 'delivered-during-retry', payload('email.delivered', at(5)));
    expect(delivered).toMatchObject({ matched: true, ignored: false });
    const completedAt = at(6);
    const base = { messageId: 'message-1', userId: 'user-1', provider: 'resend', providerMessageId: 're_1',
      lastEvent: 'submission' as const, lastEventAt: completedAt, createdAt: completedAt, updatedAt: completedAt };
    await env.DB.batch([
      upsertOutboundStatus(env.DB, { ...base, status: 'submitted', attempts: 2, idempotencyKey: 'flaremail:send:user-1:compose-1',
        lastError: '', submittedAt: completedAt, sentAt: null, deliveredAt: null }),
      upsertOutboundReceipt(env.DB, { ...base, attemptNumber: 2, resultKind: 'accepted', remoteStatus: 200, responsePreview: '' })
    ]);
    expect(database.query("SELECT status, last_event FROM workspace_delivery_statuses WHERE message_id = 'message-1'").get())
      .toEqual({ status: 'delivered', last_event: 'email.delivered' });
    expect(database.query("SELECT last_event FROM workspace_outbound_receipts WHERE message_id = 'message-1'").get())
      .toEqual({ last_event: 'email.delivered' });
    expect(database.query("SELECT state FROM workspace_delivery_attention WHERE kind = 'delayed'").get())
      .toEqual({ state: 'resolved' });

    await upsertOutboundStatus(env.DB, { ...base, providerMessageId: 're_2', status: 'submitted', attempts: 2,
      idempotencyKey: 'flaremail:send:user-1:compose-1', lastError: '', submittedAt: completedAt, sentAt: null, deliveredAt: null }).run();
    database.query("UPDATE workspace_delivery_attempts SET provider_message_id = 're_2' WHERE id = 'new-attempt'").run();
    expect(database.query("SELECT delivered_at FROM workspace_delivery_statuses WHERE message_id = 'message-1'").get())
      .toEqual({ delivered_at: null });
    const newDeliveredAt = at(7);
    await applyResendDeliveryWebhook(env, 'delivered-replacement-id', payload('email.delivered', newDeliveredAt, 're_2'));
    expect(database.query("SELECT delivered_at FROM workspace_delivery_statuses WHERE message_id = 'message-1'").get())
      .toEqual({ delivered_at: newDeliveredAt });
  });

  test.each(['re_1', 're_new'])('keeps the prior delay only when retry acceptance replays provider ID %s', async (providerId) => {
    const { database, env } = setup();
    const db = env.DB;
    const at = (second: number) => new Date(Date.now() + second * 1000).toISOString();
    await applyResendDeliveryWebhook(env, 'delay-before-replay', payload('email.delivery_delayed', at(1)));
    const original = (await page(db)).notices[0]!;
    database.query("UPDATE workspace_delivery_statuses SET status = 'submitting', attempts = 2, last_event_at = ? WHERE message_id = 'message-1'").run(at(2));
    database.query("UPDATE workspace_delivery_statuses SET status = 'submitted', provider_message_id = ? WHERE message_id = 'message-1'").run(providerId);
    const expected = providerId === 're_1' ? [original.id] : [];
    expect((await page(db)).notices.map(({ id }) => id)).toEqual(expected);
    await applyResendDeliveryWebhook(env, 'sent-after-replay', payload('email.sent', at(3), providerId));
    expect((await page(db)).notices.map(({ id }) => id)).toEqual(expected);
    await applyResendDeliveryWebhook(env, 'delivered-after-replay', payload('email.delivered', at(4), providerId));
    expect((await page(db)).notices).toEqual([]);
    expect((await page(db, 'history')).notices.find(({ id }) => id === original.id)?.state).toBe('resolved');
  });

  test.each(['open', 'acknowledged'])('restores a %s delay after a stalled same-ID retry', async (state) => {
    const { database, env } = setup();
    const db = env.DB;
    await applyResendDeliveryWebhook(env, 'delay-preceding-timeout', payload('email.delivery_delayed', '2026-01-01T00:01:00.000Z'));
    const original = (await page(db)).notices[0]!;
    if (state === 'acknowledged') await changeDeliveryAttention(db, 'user-1', { action: 'acknowledge', incident: ref(original) });
    database.exec(`
      UPDATE workspace_delivery_statuses SET status = 'submitting', attempts = 2, last_event_at = '2026-01-01T00:02:00.000Z'
        WHERE message_id = 'message-1';
    `);
    expect((await page(db)).notices.map(({ kind }) => kind)).toEqual(['stale_submitting']);
    const beforeReplay = (await page(db)).summary.snapshot;
    database.exec(`
      UPDATE workspace_delivery_statuses SET attempts = 3, last_event_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE message_id = 'message-1';
      UPDATE workspace_delivery_statuses SET status = 'submitted' WHERE message_id = 'message-1';
    `);
    const restored = await findCurrentDeliveryAttention(db, 'user-1', 'message-1');
    expect(restored).toMatchObject({ id: original.id, state, occurredAt: original.occurredAt });
    expect(restored?.version).toBeGreaterThan(beforeReplay.version);
    expect((await changeDeliveryAttention(db, 'user-1', { action: 'acknowledge_all', snapshot: beforeReplay })).changed).toBe(0);
    expect((await page(db)).notices.map(({ id }) => id)).toEqual(state === 'open' ? [original.id] : []);
  });

  test('excludes a delay restored after successive retry timeouts from the older bulk snapshot', async () => {
    const { database, env } = setup();
    const db = env.DB;
    const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
    await applyResendDeliveryWebhook(env, 'known-delay', payload('email.delivery_delayed', at(-3600)));
    const original = (await page(db)).notices[0]!;
    const insert = database.query(`INSERT INTO workspace_delivery_attempts
      (id, message_id, user_id, attempt_number, provider, status, started_at, error)
      VALUES (?, 'message-1', 'user-1', ?, 'resend', 'submitting', ?, 'timeout')`);
    const project = database.query(`UPDATE workspace_delivery_statuses SET status = 'submitting', attempts = ?,
      last_event = 'submission', last_event_at = ? WHERE message_id = 'message-1'`);
    insert.run('stalled', 2, at(-1200));
    project.run(2, at(-1185));
    insert.run('returned', 3, at(-30));
    project.run(3, at(-15));
    const before = await page(db);
    expect(before.notices.map(({ kind }) => kind)).toEqual(['stale_submitting']);
    await applyResendDeliveryWebhook(env, 'late-provider-delay', payload('email.delivery_delayed', at(-1)));
    const restored = (await page(db)).notices[0]!;
    expect(restored.id).toBe(original.id);
    expect(restored.version).toBeGreaterThan(before.summary.snapshot.version);
    expect((await changeDeliveryAttention(db, 'user-1', { action: 'acknowledge_all', snapshot: before.summary.snapshot })).changed).toBe(0);
  });

  test('clears a retry rate limit and restores the provider delay after same-ID acceptance', async () => {
    const { database, env } = setup();
    const db = env.DB;
    await applyResendDeliveryWebhook(env, 'delay-before-rate-limit', payload('email.delivery_delayed', new Date().toISOString()));
    const original = (await page(db)).notices[0]!;
    await changeDeliveryAttention(db, 'user-1', { action: 'acknowledge', incident: ref(original) });
    database.exec(`
      UPDATE workspace_delivery_statuses SET status = 'submitting', attempts = 2, last_event = 'submission',
        last_event_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE message_id = 'message-1';
      UPDATE workspace_delivery_statuses SET status = 'delayed' WHERE message_id = 'message-1';
    `);
    const rateLimit = (await page(db)).notices[0]!;
    expect(rateLimit.id).not.toBe(original.id);
    database.exec(`
      UPDATE workspace_delivery_statuses SET status = 'submitting', attempts = 3 WHERE message_id = 'message-1';
      UPDATE workspace_delivery_statuses SET status = 'submitted' WHERE message_id = 'message-1';
    `);
    expect((await page(db)).notices).toEqual([]);
    const current = await findCurrentDeliveryAttention(db, 'user-1', 'message-1');
    expect(current).toMatchObject({ id: original.id, state: 'acknowledged' });
    expect(current?.version).toBeGreaterThan(rateLimit.version);
    expect((await page(db, 'history')).notices.find(({ id }) => id === rateLimit.id)?.state).toBe('resolved');
  });

  test('opens a distinct provider delay after an acknowledged submission rate limit', async () => {
    const { database, env } = setup();
    const db = env.DB;
    database.exec(`
      UPDATE workspace_delivery_statuses SET status = 'delayed', last_event = 'submission',
        last_event_at = '2027-01-15T08:01:00.000Z' WHERE message_id = 'message-1';
    `);
    const rateLimit = (await page(db)).notices[0]!;
    await changeDeliveryAttention(db, 'user-1', { action: 'acknowledge', incident: ref(rateLimit) });
    await applyResendDeliveryWebhook(env, 'first-provider-delay-after-rate-limit',
      payload('email.delivery_delayed', '2027-01-15T08:02:00Z'));
    const notices = (await page(db)).notices;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'delayed', state: 'open' });
    expect(notices[0]?.id).not.toBe(rateLimit.id);
    expect((await page(db, 'history')).notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: rateLimit.id, state: 'superseded' })
    ]));
  });

  test.each([false, true])('keeps the provider delay acknowledgement (%s) after an acknowledged rate limit', async (acknowledged) => {
    const { database, env } = setup();
    const db = env.DB;
    const at = (minute: number) => `2026-01-01T00:0${minute}:00.000Z`;
    await applyResendDeliveryWebhook(env, 'first-provider-delay', payload('email.delivery_delayed', at(1)));
    const original = (await page(db)).notices[0]!;
    if (acknowledged) await changeDeliveryAttention(db, 'user-1', { action: 'acknowledge', incident: ref(original) });
    database.exec(`
      UPDATE workspace_delivery_statuses SET status = 'submitting', attempts = 2, last_event = 'submission',
        last_event_at = '${at(2)}' WHERE message_id = 'message-1';
      INSERT INTO workspace_delivery_attempts (id, message_id, user_id, attempt_number, provider, status, started_at, completed_at)
      VALUES ('limited', 'message-1', 'user-1', 2, 'resend', 'delayed', '${at(2)}', '${at(3)}');
      UPDATE workspace_delivery_statuses SET status = 'delayed', last_event_at = '${at(3)}' WHERE message_id = 'message-1';
    `);
    const local = await findCurrentDeliveryAttention(db, 'user-1', 'message-1');
    expect(local?.id).not.toBe(original.id);
    await changeDeliveryAttention(db, 'user-1', { action: 'acknowledge', incident: ref(local!) });
    await applyResendDeliveryWebhook(env, 'second-provider-delay', payload('email.delivery_delayed', at(4)));
    const current = await findCurrentDeliveryAttention(db, 'user-1', 'message-1');
    expect(current).toMatchObject({
      id: original.id, state: acknowledged ? 'acknowledged' : 'open', occurredAt: original.occurredAt
    });
    expect(current?.version).toBeGreaterThan(local!.version);
    expect((await page(db, 'history')).notices.find(({ id }) => id === local?.id)?.state).toBe('superseded');
  });

  test.each([
    ['submitted', 're_1', 're_1', false, true],
    ['sent', 're_1', 're_1', false, true],
    ['delayed', 're_1', 're_1', false, true],
    ['sent', 're_older', 're_1', false, false],
    ['sent', 're_1', 're_older', false, false],
    ['sent', 're_1', 're_1', true, false]
  ] as const)('migrates masked failures (%s, prior %s, event %s)', async (status, priorId, eventId, competingOutcome, shouldReplay) => {
    const { database, env } = setup();
    const failedAt = '2026-01-01T00:01:00.000Z';
    database.exec(`
      UPDATE workspace_schema_metadata SET schema_version = 38;
      INSERT INTO workspace_delivery_attempts (id, message_id, user_id, attempt_number, provider, provider_message_id, status, started_at, completed_at)
      VALUES ('initial', 'message-1', 'user-1', 1, 'resend', '${priorId}', 'submitted', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:30.000Z'),
        ('retry', 'message-1', 'user-1', 2, 'resend', 're_1', 'submitted', '2026-01-01T00:02:00.000Z', '2026-01-01T00:03:00.000Z');
      UPDATE workspace_delivery_statuses SET status = '${status}', attempts = 2, last_event_at = '2026-01-01T00:03:00.000Z',
        last_event = CASE '${status}' WHEN 'sent' THEN 'email.sent' WHEN 'delayed' THEN 'email.delivery_delayed' ELSE 'submission' END;
    `);
    database.query(`INSERT INTO workspace_outbound_events
      (svix_id, message_id, user_id, provider, provider_message_id, event_type, event_created_at, payload_json)
      VALUES ('legacy-failure', 'message-1', 'user-1', 'resend', ?, 'email.failed', ?, ?)`)
      .run(eventId, failedAt, JSON.stringify(payload('email.failed', failedAt, eventId)));
    database.exec(`
      INSERT INTO workspace_outbound_events (svix_id, message_id, user_id, provider, provider_message_id, event_type, event_created_at)
      VALUES ('local:message-1:submission:2', 'message-1', 'user-1', 'resend', 're_1', 'submission', '2026-01-01T00:03:00.000Z');
    `);
    if (competingOutcome) database.exec(`
      INSERT INTO workspace_outbound_events (svix_id, message_id, user_id, provider, provider_message_id, event_type, event_created_at)
      VALUES ('legacy-bounce', 'message-1', 'user-1', 'resend', 're_1', 'email.bounced', '2026-01-01T00:04:00.000Z');
    `);

    database.exec(readFileSync(new URL('../../../../migrations/0039_queue_legacy_resend_failures.sql', import.meta.url), 'utf8'));
    expect(database.query("SELECT json_extract(payload_json, '$._flaremailDeferred') AS queued FROM workspace_outbound_events WHERE svix_id = 'legacy-failure'").get())
      .toEqual({ queued: shouldReplay ? 1 : null });
    await reconcileDeferredResendEvents(env);
    const detail = await findDeliveryDetailRows(env.DB, 'user-1', 'message-1');
    expect(detail.status).toBe(shouldReplay ? 'failed' : status);
    if (shouldReplay) {
      expect(detail.receipt).toMatchObject({ result_kind: 'permanent_failure', last_event: 'email.failed' });
      expect((await page(env.DB)).notices).toMatchObject([{ kind: 'failed', state: 'open' }]);
      expect(database.query("SELECT attempt_number FROM workspace_delivery_attention WHERE kind = 'failed'").get())
        .toEqual({ attempt_number: 2 });
      await reconcileDeferredResendEvents(env);
      expect((await page(env.DB)).notices).toHaveLength(1);
    }
  });

  test('opens a provider failure after acknowledgement of the local submission failure', async () => {
    const { database, env } = setup();
    const db = env.DB;
    database.query("UPDATE workspace_delivery_statuses SET status = 'failed' WHERE message_id = 'message-1'").run();
    const local = (await page(db)).notices[0]!;
    await changeDeliveryAttention(db, 'user-1', { action: 'acknowledge', incident: ref(local) });
    await applyResendDeliveryWebhook(env, 'confirmed-failure', payload('email.failed', '2027-01-15T08:02:00Z'));
    const current = (await page(db)).notices;
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ kind: 'failed', state: 'open' });
    expect(current[0]?.id).not.toBe(local.id);
    expect((await page(db, 'history')).notices.find(({ id }) => id === local.id)?.state).toBe('superseded');
  });

  test('accepts a definitive bounce for the last known provider ID after a retry times out', async () => {
    const { database, env } = setup();
    await applyResendDeliveryWebhook(env, 'initial-delay', payload('email.delivery_delayed', '2027-01-15T08:02:00.000Z'));
    database.exec(`
      INSERT INTO workspace_delivery_attempts (id, message_id, user_id, attempt_number, provider, status, error, started_at)
      VALUES ('uncertain', 'message-1', 'user-1', 2, 'resend', 'submitting', 'timeout', '2027-01-15T08:03:00.000Z');
      UPDATE workspace_delivery_statuses SET status = 'submitting', attempts = 2, last_event = 'submission',
        last_event_at = '2027-01-15T08:03:00.000Z' WHERE message_id = 'message-1';
    `);
    const bounce = await applyResendDeliveryWebhook(env, 'definitive-bounce', payload('email.bounced', '2027-01-15T08:04:00.000Z'));
    expect(bounce).toMatchObject({ matched: true, ignored: false });
    expect(await findDeliveryDetailRows(env.DB, 'user-1', 'message-1')).toMatchObject({
      status: 'bounced', receipt: { last_event: 'email.bounced' }, attention: { kind: 'bounced', state: 'open' }
    });
    expect(await findDeliveryDetailRows(env.DB, 'other-owner', 'message-1')).toMatchObject({
      status: null, receipt: null, attention: null, events: []
    });
  });

  test('records the first delay webhook for an old provider ID when the retry returns that ID', async () => {
    const { database, env } = setup();
    database.exec(`
      INSERT INTO workspace_delivery_attempts (id, message_id, user_id, attempt_number, provider, status, started_at)
      VALUES ('retry', 'message-1', 'user-1', 2, 'resend', 'submitting', '2026-01-01T00:03:00.000Z');
      UPDATE workspace_delivery_statuses SET status = 'submitting', attempts = 2, last_event = 'submission',
        last_event_at = '2026-01-01T00:03:00.000Z' WHERE message_id = 'message-1';
    `);
    const firstDelay = await applyResendDeliveryWebhook(env, 'deferred-first-delay', payload('email.delivery_delayed', '2026-01-01T00:02:00.000Z'));
    expect(firstDelay).toMatchObject({ matched: true, ignored: true });
    database.exec(`
      UPDATE workspace_delivery_attempts SET provider_message_id = 're_1', status = 'submitted' WHERE id = 'retry';
      UPDATE workspace_delivery_statuses SET status = 'submitted' WHERE message_id = 'message-1';
    `);
    expect(await reconcilePendingResendEvents(env, 're_1')).toBe(1);
    expect(await findDeliveryDetailRows(env.DB, 'user-1', 'message-1')).toMatchObject({
      status: 'delayed', attention: { kind: 'delayed', state: 'open' }
    });
  });

  test('keeps an acknowledged delay when a newer delay follows same-ID acceptance', async () => {
    const { database, env } = setup();
    const db = env.DB;
    const at = (minute: number) => `2026-01-01T00:0${minute}:00.000Z`;
    await applyResendDeliveryWebhook(env, 'original-delay', payload('email.delivery_delayed', at(1)));
    const original = (await page(db)).notices[0]!;
    await changeDeliveryAttention(db, 'user-1', { action: 'acknowledge', incident: ref(original) });
    database.exec(`
      INSERT INTO workspace_delivery_attempts (id, message_id, user_id, attempt_number, provider, provider_message_id, status, started_at)
      VALUES ('retry', 'message-1', 'user-1', 2, 'resend', 're_1', 'submitted', '${at(2)}');
      UPDATE workspace_delivery_statuses SET status = 'submitting', attempts = 2, last_event = 'submission', last_event_at = '${at(2)}'
        WHERE message_id = 'message-1';
      UPDATE workspace_delivery_statuses SET status = 'submitted', last_event_at = '${at(3)}' WHERE message_id = 'message-1';
    `);
    await applyResendDeliveryWebhook(env, 'retry-delay', payload('email.delivery_delayed', at(4)));
    expect((await page(db)).notices).toEqual([]);
    expect(await findDeliveryDetailRows(db, 'user-1', 'message-1')).toMatchObject({
      status: 'delayed', attention: { id: original.id, state: 'acknowledged' }
    });
  });

  test('keeps a newer sent webhook for the original ID when its replay predates the retry', async () => {
    const { database, env } = setup();
    const at = (minute: number) => `2026-01-01T00:0${minute}:00.000Z`;
    await applyResendDeliveryWebhook(env, 'original-delay', payload('email.delivery_delayed', at(1)));
    const original = (await page(env.DB)).notices[0]!;
    database.exec(`
      INSERT INTO workspace_delivery_attempts (id, message_id, user_id, attempt_number, provider, status, started_at)
      VALUES ('retry', 'message-1', 'user-1', 2, 'resend', 'submitting', '${at(3)}');
      UPDATE workspace_delivery_statuses SET status = 'submitting', attempts = 2, last_event = 'submission',
        last_event_at = '${at(3)}', sent_at = NULL WHERE message_id = 'message-1';
    `);
    await applyResendDeliveryWebhook(env, 'stale-sent', payload('email.sent', at(0)));
    await applyResendDeliveryWebhook(env, 'later-sent', payload('email.sent', at(2)));
    database.exec(`
      UPDATE workspace_delivery_attempts SET provider_message_id = 're_1', status = 'submitted' WHERE id = 'retry';
      UPDATE workspace_delivery_statuses SET status = 'submitted' WHERE message_id = 'message-1';
    `);
    expect(await reconcilePendingResendEvents(env, 're_1')).toBe(2);
    expect(database.query("SELECT status, sent_at FROM workspace_delivery_statuses WHERE message_id = 'message-1'").get())
      .toEqual({ status: 'sent', sent_at: at(2) });
    expect((await page(env.DB)).notices.map(({ id }) => id)).toEqual([original.id]);
  });

  test.each(['2027-01-15T08:01:00Z', '2027-01-15T08:02:00Z'])('keeps the early delay after a sent webhook timestamped %s', async (sentAt) => {
    const { database, env } = setup();
    database.exec("UPDATE workspace_delivery_statuses SET status = 'submitting', provider_message_id = NULL");
    await applyResendDeliveryWebhook(env, 'early-delay', payload('email.delivery_delayed', '2027-01-15T08:01:00Z'));
    database.exec("UPDATE workspace_delivery_statuses SET status = 'submitted', provider_message_id = 're_1'");
    await attachMatchedOutboundEvents(env.DB, 're_1').run();
    await applyResendDeliveryWebhook(env, 'live-sent', payload('email.sent', sentAt));
    expect(await reconcilePendingResendEvents(env, 're_1')).toBe(1);
    expect(await findDeliveryDetailRows(env.DB, 'user-1', 'message-1')).toMatchObject({
      status: 'sent', receipt: { last_event: 'email.sent' }, attention: { kind: 'delayed', state: 'open' }
    });
    expect(await reconcilePendingResendEvents(env, 're_1')).toBe(0);
  });

  test('scheduled reconciliation recovers a deferred event after a transient write failure', async () => {
    const { database, env } = setup();
    const now = Date.now();
    const at = (second: number) => new Date(now + second * 1_000).toISOString();
    database.exec(`
      INSERT INTO workspace_delivery_attempts (id, message_id, user_id, attempt_number, provider, status, started_at)
      VALUES ('retry', 'message-1', 'user-1', 2, 'resend', 'submitting', '${at(-60)}');
      UPDATE workspace_delivery_statuses SET status = 'submitting', attempts = 2, last_event = 'submission', last_event_at = '${at(-60)}'
        WHERE message_id = 'message-1';
    `);
    for (let second = 2; second <= 6; second++) {
      await applyResendDeliveryWebhook(env, `cron-sent-${second}`, payload('email.sent', at(second)));
    }
    await reconcileDeferredResendEvents(env);
    expect((await findDeliveryDetailRows(env.DB, 'user-1', 'message-1')).status).toBe('submitting');
    database.exec(`
      UPDATE workspace_delivery_attempts SET provider_message_id = 're_1', status = 'submitted' WHERE id = 'retry';
      UPDATE workspace_delivery_statuses SET status = 'submitted' WHERE message_id = 'message-1';
    `);
    const d1 = env.DB as unknown as TestD1;
    d1.beforeBatch = () => { throw new Error('transient write failure'); };
    await expect(reconcileDeferredResendEvents(env)).rejects.toMatchObject({ code: 'DELIVERY_PERSISTENCE_UNAVAILABLE' });
    d1.beforeBatch = undefined;
    await reconcileDeferredResendEvents(env);
    expect((await findDeliveryDetailRows(env.DB, 'user-1', 'message-1')).status).toBe('sent');
    expect(database.query(`SELECT svix_id FROM workspace_outbound_events
      WHERE json_extract(payload_json, '$._flaremailDeferred') = 1`).all()).toEqual([{ svix_id: 'cron-sent-6' }]);
    await reconcileDeferredResendEvents(env);
    expect(await reconcilePendingResendEvents(env, 're_1')).toBe(0);
  });

  test('scheduled reconciliation recovers the current provider event after a retry is abandoned', async () => {
    const { database, env } = setup();
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    await applyResendDeliveryWebhook(env, 'delay-before-retry', payload('email.delivery_delayed', at(20)));
    database.exec(`
      INSERT INTO workspace_delivery_attempts (id, message_id, user_id, attempt_number, provider, status, started_at)
      VALUES ('interrupted', 'message-1', 'user-1', 2, 'resend', 'submitting', '${at(18)}');
      UPDATE workspace_delivery_statuses SET status = 'submitting', attempts = 2, last_event = 'submission', last_event_at = '${at(18)}'
        WHERE message_id = 'message-1';
    `);
    await applyResendDeliveryWebhook(env, 'deferred-sent', payload('email.sent', at(17)));
    expect((await findDeliveryDetailRows(env.DB, 'user-1', 'message-1')).status).toBe('submitting');
    await reconcileDeferredResendEvents(env);
    expect(await findDeliveryDetailRows(env.DB, 'user-1', 'message-1')).toMatchObject({
      status: 'sent', receipt: { last_event: 'email.sent' }, attention: { kind: 'delayed' }
    });
  });

  test('a stale replay cannot change the status after another replay consumed the same event', async () => {
    const { database, env } = setup();
    database.exec(`
      INSERT INTO workspace_delivery_attempts (id, message_id, user_id, attempt_number, provider, status, started_at)
      VALUES ('retry', 'message-1', 'user-1', 2, 'resend', 'submitting', '2026-01-01T00:01:00.000Z');
      UPDATE workspace_delivery_statuses SET status = 'submitting', attempts = 2, last_event = 'submission'
        WHERE message_id = 'message-1';
    `);
    await applyResendDeliveryWebhook(env, 'claimed-delay', payload('email.delivery_delayed', '2026-01-01T00:02:00Z'));
    database.exec(`
      UPDATE workspace_delivery_attempts SET provider_message_id = 're_1', status = 'submitted' WHERE id = 'retry';
      UPDATE workspace_delivery_statuses SET status = 'submitted' WHERE message_id = 'message-1';
    `);
    const d1 = env.DB as unknown as TestD1;
    d1.beforeBatch = () => {
      d1.beforeBatch = undefined;
      database.query("UPDATE workspace_outbound_events SET payload_json = json_remove(payload_json, '$._flaremailDeferred') WHERE svix_id = 'claimed-delay'").run();
    };
    expect(await reconcilePendingResendEvents(env, 're_1')).toBe(0);
    expect((await findDeliveryDetailRows(env.DB, 'user-1', 'message-1')).status).toBe('submitted');
    expect((await page(env.DB)).notices).toEqual([]);
  });

  test('applies newer deferred provider state without reopening an acknowledged delay', async () => {
    const { database, env } = setup();
    const db = env.DB;
    const at = (minute: number) => `2026-01-01T00:0${minute}:00.000Z`;
    await applyResendDeliveryWebhook(env, 'prior-delay', payload('email.delivery_delayed', at(1)));
    const original = (await page(db)).notices[0]!;
    await changeDeliveryAttention(db, 'user-1', { action: 'acknowledge', incident: ref(original) });
    database.exec(`
      INSERT INTO workspace_delivery_attempts (id, message_id, user_id, attempt_number, provider, status, started_at)
      VALUES ('retry', 'message-1', 'user-1', 2, 'resend', 'submitting', '${at(4)}');
      UPDATE workspace_delivery_statuses SET status = 'submitting', attempts = 2, last_event = 'submission',
        last_event_at = '${at(4)}', sent_at = NULL WHERE message_id = 'message-1';
    `);
    await applyResendDeliveryWebhook(env, 'newer-delay', payload('email.delivery_delayed', at(3)));
    await applyResendDeliveryWebhook(env, 'previously-sent', payload('email.sent', at(2)));
    database.exec(`
      UPDATE workspace_delivery_attempts SET provider_message_id = 're_1', status = 'submitted' WHERE id = 'retry';
      UPDATE workspace_delivery_statuses SET status = 'submitted' WHERE message_id = 'message-1';
    `);
    expect(await reconcilePendingResendEvents(env, 're_1')).toBe(2);
    expect(database.query("SELECT status, sent_at FROM workspace_delivery_statuses WHERE message_id = 'message-1'").get())
      .toEqual({ status: 'delayed', sent_at: at(2) });
    expect((await page(db)).notices).toEqual([]);
    expect(await findDeliveryDetailRows(db, 'user-1', 'message-1')).toMatchObject({
      status: 'delayed', receipt: { last_event_at: at(3) }, attention: { id: original.id, state: 'acknowledged' }
    });
  });

  test.each([-100, 500])('attributes a deferred delay %i milliseconds from the start of a confirmed retry', async (offset) => {
    const { database, env } = setup();
    const startedAt = Math.floor(Date.now() / 1000) * 1000 + 300;
    const now = new Date(startedAt).toISOString();
    await applyResendDeliveryWebhook(env, 'previous-delay', payload('email.delivery_delayed', now));
    database.exec(`
      INSERT INTO workspace_delivery_attempts (id, message_id, user_id, attempt_number, provider, provider_message_id, status, started_at)
      VALUES ('original', 'message-1', 'user-1', 1, 'resend', 're_1', 'submitted', '2026-01-01T00:00:00.000Z');
      INSERT INTO workspace_delivery_attempts (id, message_id, user_id, attempt_number, provider, status, started_at)
      VALUES ('retry', 'message-1', 'user-1', 2, 'resend', 'submitting', '${now}');
      UPDATE workspace_delivery_statuses SET status = 'submitting', attempts = 2, last_event = 'submission',
        last_event_at = '${now}' WHERE message_id = 'message-1';
    `);
    const eventAt = new Date(startedAt + offset).toISOString();
    const newDelay = await applyResendDeliveryWebhook(env, 'retry-delay', payload('email.delivery_delayed', eventAt));
    expect(newDelay).toMatchObject({ matched: true, ignored: true });
    const pending = await findDeliveryDetailRows(env.DB, 'user-1', 'message-1');
    const deferred = pending.events.find(({ svix_id }) => svix_id === 'retry-delay');
    expect(deferred?.event_type).toBe('email.delivery_delayed');
    expect(deferred?.payload_json).not.toContain('_flaremailDeferred');
    expect(await reconcilePendingResendEvents(env, 're_1')).toBe(0);
    database.exec(`
      UPDATE workspace_delivery_attempts SET provider_message_id = 're_1', status = 'submitted' WHERE id = 'retry';
      UPDATE workspace_delivery_statuses SET status = 'submitted' WHERE message_id = 'message-1';
    `);
    expect(await reconcilePendingResendEvents(env, 're_1')).toBe(1);
    expect(await reconcilePendingResendEvents(env, 're_1')).toBe(0);
    expect((await page(env.DB, 'pending')).notices.map(({ kind }) => kind)).toEqual(['delayed']);
    expect(database.query("SELECT attempt_number FROM workspace_delivery_attention WHERE state = 'open'").get())
      .toEqual({ attempt_number: offset > 0 ? 2 : 1 });

    if (offset < 0) {
      const original = (await page(env.DB)).notices[0]!;
      await changeDeliveryAttention(env.DB, 'user-1', { action: 'acknowledge', incident: ref(original) });
      const late = await applyResendDeliveryWebhook(env, 'retry-late-delay', payload('email.delivery_delayed', eventAt));
      expect(late).toMatchObject({ ignored: true });
      expect((await page(env.DB)).notices).toEqual([]);
      expect(await findCurrentDeliveryAttention(env.DB, 'user-1', 'message-1')).toMatchObject({ id: original.id, state: 'acknowledged' });
    }
  });

  test('bulk confirmation is idempotent and excludes new, newly stale, restored and reopened incidents', async () => {
    const { database, env } = setup();
    const db = env.DB;
    addDelivery(database, 'hidden', 'bounced');
    addDelivery(database, 'reopened', 'bounced');
    addDelivery(database, 'included', 'failed');
    addDelivery(database, 'potentially-stale', 'submitting', new Date().toISOString());
    database.query("UPDATE workspace_messages SET deleted_at = '2026-01-01' WHERE id = 'hidden'").run();
    const reopened = (await findCurrentDeliveryAttention(db, 'user-1', 'reopened'))!;
    const snapshot = (await getDeliveryAttentionSummary(db, 'user-1')).snapshot;
    await changeDeliveryAttention(db, 'user-1', { action: 'acknowledge', incident: ref(reopened) });
    await changeDeliveryAttention(db, 'user-1', { action: 'reopen', incident: ref(reopened) });
    addDelivery(database, 'arrived-late', 'bounced');
    database.query("UPDATE workspace_messages SET deleted_at = NULL WHERE id = 'hidden'").run();
    database.query("UPDATE workspace_delivery_statuses SET last_event_at = '2026-01-01' WHERE message_id = 'potentially-stale'").run();
    const all = { action: 'acknowledge_all', snapshot } as const;
    expect((await changeDeliveryAttention(db, 'user-1', all)).changed).toBe(1);
    expect((await changeDeliveryAttention(db, 'user-1', all)).changed).toBe(0);
    expect((await page(db)).notices.map(({ messageId }) => messageId).sort())
      .toEqual(['arrived-late', 'hidden', 'potentially-stale', 'reopened']);
    database.query("UPDATE workspace_messages SET deleted_at = '2026-01-01' WHERE id = 'included'").run();
    expect((await page(db, 'history')).notices).toEqual([]);
    database.query("UPDATE workspace_messages SET deleted_at = NULL WHERE id = 'included'").run();
    expect(await findCurrentDeliveryAttention(db, 'user-1', 'included')).toMatchObject({ state: 'acknowledged' });
    database.query("DELETE FROM workspace_messages WHERE id = 'included'").run();
    expect(database.query("SELECT id FROM workspace_delivery_attention WHERE message_id = 'included'").all()).toEqual([]);
    database.close();
  });
});
