import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  activateTelegramBinding,
  claimTelegramDelivery,
  cleanupTelegramState,
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

  test('finalizes invalid and conflicting challenge updates in the same batch', async () => {
    const invalid = database();
    expect(await consumeTelegramChallenge(invalid.d1 as unknown as D1Database, {
      updateId: 'invalid-update', processingToken: 'invalid-processing', challengeHash: 'missing-hash',
      telegramUserId: '42', telegramChatId: '42', telegramUsername: null, telegramDisplayName: 'Alice',
      now: '2026-09-09T12:00:00.000Z'
    })).toBe('invalid');
    expect(invalid.db.query(`SELECT status, result_code FROM workspace_telegram_updates WHERE update_id = 'invalid-update'`).get())
      .toEqual({ status: 'ignored', result_code: 'invalid_challenge' });

    const conflict = database();
    conflict.db.query(`INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence)
      VALUES ('user-2', 'second@example.test', 'Second', 'Owner', 'second@example.test', '', '', 'UTC', 0, '', 0)`).run();
    conflict.db.query(`INSERT INTO workspace_telegram_bindings
      (user_id, binding_id, state, telegram_user_id, telegram_chat_id, enabled, authorization_version, created_at, updated_at)
      VALUES ('user-2', 'binding-2', 'active', '99', '99', 1, 1, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`).run();
    await createTelegramChallenge(conflict.d1 as unknown as D1Database, 'user-1', 'challenge-conflict', 'conflict-hash', '2999-01-01T00:00:00.000Z');
    expect(await consumeTelegramChallenge(conflict.d1 as unknown as D1Database, {
      updateId: 'conflict-update', processingToken: 'conflict-processing', challengeHash: 'conflict-hash',
      telegramUserId: '99', telegramChatId: '99', telegramUsername: null, telegramDisplayName: 'Other',
      now: '2026-09-09T12:00:00.000Z'
    })).toBe('conflict');
    expect(conflict.db.query(`SELECT status, result_code FROM workspace_telegram_updates WHERE update_id = 'conflict-update'`).get())
      .toEqual({ status: 'ignored', result_code: 'binding_conflict' });
    expect(conflict.db.query(`SELECT status, consumed_update_id FROM workspace_telegram_bind_challenges WHERE id = 'challenge-conflict'`).get())
      .toEqual({ status: 'consumed', consumed_update_id: 'conflict-update' });
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
    db.query(`UPDATE workspace_telegram_bindings SET privacy_mode = 1, summary_enabled = 1 WHERE user_id = 'user-1'`).run();
    expect(await markTelegramExternalStarted(d1 as unknown as D1Database, claimed.id, claimed.claim_token))
      .toEqual({ privacyMode: true, summaryEnabled: false });
    await markTelegramSent(d1 as unknown as D1Database, { deliveryId: claimed.id, claimToken: claimed.claim_token, messageId: '500' });
    expect(db.query(`SELECT status, telegram_message_id, attempts FROM workspace_telegram_deliveries WHERE id = 'delivery-1'`).get())
      .toEqual({ status: 'sent', telegram_message_id: '500', attempts: 1 });
    expect(await retryTelegramDelivery(d1 as unknown as D1Database, 'user-1', 'delivery-1')).toBe(false);
  });

  test('does not claim a pending row after it reaches its maximum attempts', async () => {
    const { db, d1 } = database();
    db.query(`INSERT INTO workspace_telegram_bindings
      (user_id, binding_id, state, telegram_user_id, telegram_chat_id, enabled, authorization_version, created_at, updated_at)
      VALUES ('user-1', 'binding-1', 'active', '42', '42', 1, 1, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`).run();
    db.query(`INSERT INTO email_messages (id, "from", "to", subject, timestamp, snippet, raw_key, dedupe_key, owner_user_id)
      VALUES ('email-max', 'sender@example.test', 'owner@example.test', 'Subject', '2026-09-09T12:00:00.000Z', 'Summary', 'raw/email-max', 'dedupe-max', 'user-1')`).run();
    db.query(`INSERT INTO workspace_telegram_deliveries
      (id, owner_user_id, email_message_id, channel, binding_id, authorization_version, status, attempts, max_attempts, next_attempt_at, created_at, updated_at)
      VALUES ('delivery-max', 'user-1', 'email-max', 'telegram', 'binding-1', 1, 'failed', 5, 5,
        '2026-09-09T12:00:00.000Z', '2026-09-09T12:00:00.000Z', '2026-09-09T12:00:00.000Z')`).run();

    expect(await claimTelegramDelivery(d1 as unknown as D1Database, '2026-09-09T12:00:01.000Z', '2026-09-09T12:01:01.000Z')).toBeNull();
    expect(await retryTelegramDelivery(d1 as unknown as D1Database, 'user-1', 'delivery-max')).toBe(true);
    expect(db.query(`SELECT status, attempts FROM workspace_telegram_deliveries WHERE id = 'delivery-max'`).get())
      .toEqual({ status: 'pending', attempts: 0 });
  });

  test('keeps action limits durable and enables a candidate only through confirmation', async () => {
    const { db, d1 } = database();
    const first = await consumeTelegramActionLimit(d1 as unknown as D1Database, 'user-1', 'bind', 1_000, 60_000, 1);
    const second = await consumeTelegramActionLimit(d1 as unknown as D1Database, 'user-1', 'bind', 2_000, 60_000, 1);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    db.query(`INSERT INTO workspace_telegram_bindings
      (user_id, binding_id, state, telegram_user_id, telegram_chat_id, candidate_challenge_id, candidate_expires_at,
       enabled, authorization_version, created_at, updated_at)
      VALUES ('user-1', 'binding-1', 'candidate', '42', '42', 'challenge-1', '2999-01-01T00:00:00.000Z', 0, 1,
        '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`).run();
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

  test('revokes Telegram state and cancels unsent work when the account is deleted', () => {
    const { db } = database();
    db.query(`INSERT INTO workspace_telegram_bindings
      (user_id, binding_id, state, telegram_user_id, telegram_chat_id, enabled, authorization_version, created_at, updated_at)
      VALUES ('user-1', 'binding-delete', 'active', '42', '42', 1, 7, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`).run();
    db.query(`INSERT INTO workspace_telegram_bind_challenges
      (id, owner_user_id, token_hash, status, expires_at, created_at, updated_at)
      VALUES ('challenge-delete', 'user-1', 'hash-delete', 'pending', '2999-01-01T00:00:00.000Z', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`).run();
    db.query(`INSERT INTO email_messages (id, "from", "to", subject, timestamp, raw_key, dedupe_key, owner_user_id)
      VALUES ('email-delete', 'sender@example.test', 'owner@example.test', 'Subject', '2026-09-09T12:00:00.000Z', 'raw/email-delete', 'dedupe-delete', 'user-1')`).run();
    db.query(`INSERT INTO email_messages (id, "from", "to", subject, timestamp, raw_key, dedupe_key, owner_user_id)
      VALUES ('email-delete-2', 'sender@example.test', 'owner@example.test', 'Subject 2', '2026-09-09T12:01:00.000Z', 'raw/email-delete-2', 'dedupe-delete-2', 'user-1')`).run();
    db.query(`INSERT INTO workspace_telegram_deliveries
      (id, owner_user_id, email_message_id, channel, binding_id, authorization_version, status,
       next_attempt_at, created_at, updated_at)
      VALUES ('delivery-delete', 'user-1', 'email-delete', 'telegram', 'binding-delete', 7, 'pending',
        '2026-09-09T12:00:00.000Z', '2026-09-09T12:00:00.000Z', '2026-09-09T12:00:00.000Z')`).run();
    db.query(`INSERT INTO workspace_telegram_deliveries
      (id, owner_user_id, email_message_id, channel, binding_id, authorization_version, status,
       next_attempt_at, external_started, external_started_at, created_at, updated_at)
      VALUES ('delivery-started', 'user-1', 'email-delete-2', 'telegram', 'binding-delete', 7, 'processing',
        '2026-09-09T12:00:00.000Z', 1, '2026-09-09T12:00:00.000Z', '2026-09-09T12:00:00.000Z', '2026-09-09T12:00:00.000Z')`).run();
    db.query(`INSERT INTO workspace_telegram_delivery_limits (scope, next_allowed_at, updated_at)
      VALUES ('user:user-1', '2026-09-09T12:00:00.000Z', '2026-09-09T12:00:00.000Z'),
        ('chat:42', '2026-09-09T12:00:00.000Z', '2026-09-09T12:00:00.000Z')`).run();

    db.query(`DELETE FROM workspace_users WHERE id = 'user-1'`).run();

    expect(db.query(`SELECT state, enabled, telegram_chat_id, candidate_challenge_id, authorization_version
      FROM workspace_telegram_bindings WHERE user_id = 'user-1'`).get()).toEqual({
      state: 'revoked', enabled: 0, telegram_chat_id: null, candidate_challenge_id: null, authorization_version: 8
    });
    expect(db.query(`SELECT id, status FROM workspace_telegram_deliveries ORDER BY id`).all()).toEqual([
      { id: 'delivery-delete', status: 'cancelled' },
      { id: 'delivery-started', status: 'processing' }
    ]);
    expect(db.query(`SELECT status FROM workspace_telegram_bind_challenges WHERE id = 'challenge-delete'`).get()).toEqual({ status: 'replaced' });
    expect(db.query(`SELECT COUNT(*) AS count FROM workspace_telegram_delivery_limits`).get()).toEqual({ count: 0 });
  });

  test('expires candidate bindings and cancels their unsent deliveries during cleanup', async () => {
    const { db, d1 } = database();
    db.query(`INSERT INTO workspace_telegram_bindings
      (user_id, binding_id, state, telegram_user_id, telegram_chat_id, candidate_expires_at, enabled,
       authorization_version, created_at, updated_at)
      VALUES ('user-1', 'binding-expired', 'candidate', '42', '42', '2026-09-08T00:00:00.000Z', 0, 3,
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`).run();
    db.query(`INSERT INTO email_messages (id, "from", "to", subject, timestamp, raw_key, dedupe_key, owner_user_id)
      VALUES ('email-expired', 'sender@example.test', 'owner@example.test', 'Subject', '2026-09-08T00:00:00.000Z', 'raw/email-expired', 'dedupe-expired', 'user-1')`).run();
    db.query(`INSERT INTO workspace_telegram_deliveries
      (id, owner_user_id, email_message_id, channel, binding_id, authorization_version, status,
       next_attempt_at, created_at, updated_at)
      VALUES ('delivery-expired', 'user-1', 'email-expired', 'telegram', 'binding-expired', 3, 'pending',
        '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z')`).run();

    await expect(cleanupTelegramState(d1 as unknown as D1Database, '2026-09-09T00:00:00.000Z', 1)).resolves.toMatchObject({
      cancelledExpiredCandidates: 1,
      expiredCandidates: 1
    });
    expect(db.query(`SELECT state, enabled, telegram_chat_id, authorization_version FROM workspace_telegram_bindings WHERE user_id = 'user-1'`).get())
      .toEqual({ state: 'revoked', enabled: 0, telegram_chat_id: null, authorization_version: 4 });
    expect(db.query(`SELECT status FROM workspace_telegram_deliveries WHERE id = 'delivery-expired'`).get()).toEqual({ status: 'cancelled' });
  });

  test('expires and bounded-cleans retained Telegram state without removing unknown delivery reviews', async () => {
    const { db, d1 } = database();
    db.query(`INSERT INTO workspace_telegram_bind_challenges
      (id, owner_user_id, token_hash, status, expires_at, created_at, updated_at)
      VALUES ('challenge-old', 'user-1', 'hash-old', 'consumed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
    db.query(`INSERT INTO workspace_telegram_bind_challenges
      (id, owner_user_id, token_hash, status, expires_at, created_at, updated_at)
      VALUES ('challenge-expired', 'user-1', 'hash-expired', 'pending', '2026-09-08T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`).run();
    db.query(`INSERT INTO workspace_telegram_updates
      (update_id, processing_token, status, result_code, created_at, processed_at)
      VALUES ('update-old', 'processing-old', 'processed', 'bound', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
    db.query(`INSERT INTO workspace_telegram_deliveries
      (id, owner_user_id, email_message_id, channel, binding_id, authorization_version, status,
       next_attempt_at, completed_at, created_at, updated_at)
      VALUES ('delivery-old', 'user-1', 'email-old', 'telegram', 'binding-old', 1, 'sent',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
    db.query(`INSERT INTO workspace_telegram_deliveries
      (id, owner_user_id, email_message_id, channel, binding_id, authorization_version, status,
       next_attempt_at, completed_at, created_at, updated_at)
      VALUES ('delivery-unknown', 'user-1', 'email-unknown', 'telegram', 'binding-old', 1, 'unknown_delivery',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();

    await expect(cleanupTelegramState(d1 as unknown as D1Database, '2026-09-09T00:00:00.000Z', 1)).resolves.toMatchObject({
      expiredChallenges: 1,
      deletedChallenges: 1,
      deletedUpdates: 1,
      deletedDeliveries: 1
    });
    expect(db.query(`SELECT status FROM workspace_telegram_bind_challenges WHERE id = 'challenge-expired'`).get()).toEqual({ status: 'expired' });
    expect(db.query(`SELECT status FROM workspace_telegram_deliveries WHERE id = 'delivery-unknown'`).get()).toEqual({ status: 'unknown_delivery' });
  });
});
