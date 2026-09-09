import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  activateTelegramBinding,
  claimTelegramDelivery,
  consumeTelegramActionLimit,
  consumeTelegramChallenge,
  createTelegramChallenge,
  findTelegramBinding,
  insertTelegramDeliveryIfEligible,
  markTelegramExternalStarted,
  markTelegramSent,
  retryTelegramDelivery,
  updateTelegramSettings
} from './telegram';

class SqliteStatement {
  private values: unknown[] = [];
  constructor(private readonly db: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this as unknown as D1PreparedStatement; }
  first<T>() { return Promise.resolve((this.db.query(this.sql).get(...this.values as never[]) as T | null) ?? null); }
  all<T>() { return Promise.resolve({ success: true, results: this.db.query(this.sql).all(...this.values as never[]) as T[] }); }
  runSync<T>() {
    const result = this.db.query(this.sql).run(...this.values as never[]);
    return { success: true, results: [] as T[], meta: { changes: Number(result.changes ?? 0) } };
  }
  run<T>() { return Promise.resolve(this.runSync<T>()); }
}

class SqliteD1 {
  constructor(readonly db: Database) {}
  prepare(sql: string) { return new SqliteStatement(this.db, sql) as unknown as D1PreparedStatement; }
  batch(statements: D1PreparedStatement[]) {
    return Promise.resolve(this.db.transaction(() => statements.map((statement) => (statement as unknown as SqliteStatement).runSync()))());
  }
}

function database() {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
  db.query(`INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence)
    VALUES ('user-1', 'owner@example.test', 'Owner', 'Owner', 'profile@example.test', '', '', 'UTC', 0, '', 0)`).run();
  return { db, d1: new SqliteD1(db) };
}

describe('Telegram D1 state', () => {
  test('consumes a challenge once and keeps the candidate disabled', async () => {
    const { db, d1 } = database();
    await createTelegramChallenge(d1 as unknown as D1Database, 'user-1', 'challenge-1', 'token-hash', '2999-01-01T00:00:00.000Z');
    const input = {
      updateId: '100', processingToken: 'processing-1', challengeHash: 'token-hash',
      telegramUserId: '42', telegramChatId: '42', telegramUsername: 'alice',
      telegramDisplayName: 'Alice', now: '2026-09-09T12:00:00.000Z'
    } as const;
    expect(await consumeTelegramChallenge(d1 as unknown as D1Database, input)).toBe('bound');
    expect(await consumeTelegramChallenge(d1 as unknown as D1Database, { ...input, processingToken: 'processing-2' })).toBe('duplicate');
    expect(db.query(`SELECT state, enabled, telegram_chat_id FROM workspace_telegram_bindings WHERE user_id = 'user-1'`).get())
      .toEqual({ state: 'candidate', enabled: 0, telegram_chat_id: '42' });
    expect(db.query(`SELECT status, result_code FROM workspace_telegram_updates WHERE update_id = '100'`).get())
      .toEqual({ status: 'processed', result_code: 'bound' });
  });

  test('enqueues only trusted-address mail in the same durable outbox schema', async () => {
    const { db, d1 } = database();
    db.query(`INSERT INTO workspace_telegram_bindings
      (user_id, binding_id, state, telegram_user_id, telegram_chat_id, enabled, authorization_version, created_at, updated_at)
      VALUES ('user-1', 'binding-1', 'active', '42', '42', 1, 1, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`).run();
    db.query(`INSERT INTO email_messages (id, "from", "to", subject, timestamp, snippet, raw_key, dedupe_key, owner_user_id)
      VALUES ('email-1', 'sender@example.test', 'owner@example.test', 'Subject', '2026-09-09T12:00:00.000Z', 'Summary', 'raw/email-1', 'dedupe-1', 'user-1')`).run();
    await d1.batch([insertTelegramDeliveryIfEligible(d1 as unknown as D1Database, {
      deliveryId: 'delivery-1', ownerUserId: 'user-1', emailMessageId: 'email-1',
      nextAttemptAt: '2026-09-09T12:00:00.000Z', now: '2026-09-09T12:00:00.000Z'
    })]);
    expect(db.query('SELECT owner_user_id, email_message_id, status FROM workspace_telegram_deliveries').all())
      .toEqual([{ owner_user_id: 'user-1', email_message_id: 'email-1', status: 'pending' }]);

    db.query(`INSERT INTO email_messages (id, "from", "to", subject, timestamp, raw_key, dedupe_key, owner_user_id)
      VALUES ('email-2', 'sender@example.test', 'profile@example.test', 'Untrusted', '2026-09-09T12:01:00.000Z', 'raw/email-2', 'dedupe-2', 'user-1')`).run();
    await d1.batch([insertTelegramDeliveryIfEligible(d1 as unknown as D1Database, {
      deliveryId: 'delivery-2', ownerUserId: 'user-1', emailMessageId: 'email-2',
      nextAttemptAt: '2026-09-09T12:01:00.000Z', now: '2026-09-09T12:01:00.000Z'
    })]);
    expect(db.query('SELECT COUNT(*) AS count FROM workspace_telegram_deliveries').get()).toEqual({ count: 1 });
  });

  test('claims, finalizes, and manually requeues an outbox row without changing ownership', async () => {
    const { db, d1 } = database();
    db.query(`INSERT INTO workspace_telegram_bindings
      (user_id, binding_id, state, telegram_user_id, telegram_chat_id, enabled, authorization_version, created_at, updated_at)
      VALUES ('user-1', 'binding-1', 'active', '42', '42', 1, 1, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`).run();
    db.query(`INSERT INTO email_messages (id, "from", "to", subject, timestamp, snippet, raw_key, dedupe_key, owner_user_id)
      VALUES ('email-1', 'sender@example.test', 'owner@example.test', 'Subject', '2026-09-09T12:00:00.000Z', 'Summary', 'raw/email-1', 'dedupe-1', 'user-1')`).run();
    await d1.batch([insertTelegramDeliveryIfEligible(d1 as unknown as D1Database, {
      deliveryId: 'delivery-1', ownerUserId: 'user-1', emailMessageId: 'email-1',
      nextAttemptAt: '2026-09-09T12:00:00.000Z', now: '2026-09-09T12:00:00.000Z'
    })]);
    const claimed = await claimTelegramDelivery(d1 as unknown as D1Database, '2026-09-09T12:00:01.000Z', '2026-09-09T12:01:01.000Z');
    expect(claimed).toMatchObject({ id: 'delivery-1', telegram_chat_id: '42', attempts: 1 });
    if (!claimed) throw new Error('expected a claim');
    expect(await markTelegramExternalStarted(d1 as unknown as D1Database, claimed.id, claimed.claim_token)).toBe(true);
    await markTelegramSent(d1 as unknown as D1Database, { deliveryId: claimed.id, claimToken: claimed.claim_token, messageId: '500' });
    expect(db.query(`SELECT status, telegram_message_id, attempts FROM workspace_telegram_deliveries WHERE id = 'delivery-1'`).get())
      .toEqual({ status: 'sent', telegram_message_id: '500', attempts: 1 });
    expect(await retryTelegramDelivery(d1 as unknown as D1Database, 'user-1', 'delivery-1')).toBe(false);
  });

  test('keeps action limits durable and enables a candidate only through confirmation', async () => {
    const { db, d1 } = database();
    const first = await consumeTelegramActionLimit(d1 as unknown as D1Database, 'user-1', 'bind', 1_000, 60_000, 1);
    const second = await consumeTelegramActionLimit(d1 as unknown as D1Database, 'user-1', 'bind', 2_000, 60_000, 1);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    db.query(`INSERT INTO workspace_telegram_bindings
      (user_id, binding_id, state, telegram_user_id, telegram_chat_id, enabled, authorization_version, created_at, updated_at)
      VALUES ('user-1', 'binding-1', 'candidate', '42', '42', 0, 1, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`).run();
    expect(await activateTelegramBinding(d1 as unknown as D1Database, 'user-1')).toBe(true);
    expect((await updateTelegramSettings(d1 as unknown as D1Database, 'user-1', { enabled: true, privacyMode: true }))?.enabled).toBe(1);
    expect(db.query(`SELECT state, enabled, privacy_mode FROM workspace_telegram_bindings WHERE user_id = 'user-1'`).get())
      .toEqual({ state: 'active', enabled: 1, privacy_mode: 1 });
  });

  test('does not confirm an expired candidate', async () => {
    const { db, d1 } = database();
    db.query(`INSERT INTO workspace_telegram_bindings
      (user_id, binding_id, state, telegram_user_id, telegram_chat_id, candidate_expires_at, enabled, authorization_version, created_at, updated_at)
      VALUES ('user-1', 'binding-1', 'candidate', '42', '42', '2026-09-09T11:59:59.000Z', 0, 1, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`).run();
    expect(await activateTelegramBinding(d1 as unknown as D1Database, 'user-1', '2026-09-09T12:00:00.000Z')).toBe(false);
    expect(db.query(`SELECT state, enabled FROM workspace_telegram_bindings WHERE user_id = 'user-1'`).get())
      .toEqual({ state: 'candidate', enabled: 0 });
  });
});
