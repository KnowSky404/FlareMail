import { nowIso } from '$lib/server/workspace/shared';

export type TelegramBindingState = 'candidate' | 'active' | 'revoked';
export type TelegramDeliveryStatus = 'pending' | 'processing' | 'retryable' | 'sent' | 'failed' | 'unknown_delivery' | 'cancelled';

export interface TelegramBindingRow {
  user_id: string;
  binding_id: string;
  state: TelegramBindingState;
  telegram_user_id: string | null;
  telegram_chat_id: string | null;
  telegram_username: string | null;
  telegram_display_name: string;
  candidate_challenge_id: string | null;
  candidate_expires_at: string | null;
  enabled: number;
  privacy_mode: number;
  summary_enabled: number;
  authorization_version: number;
  bound_at: string | null;
  confirmed_at: string | null;
  revoked_at: string | null;
  last_sent_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TelegramChallengeRow {
  id: string;
  owner_user_id: string;
  token_hash: string;
  status: 'pending' | 'consumed' | 'replaced' | 'expired';
  expires_at: string;
  consumed_at: string | null;
  replaced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TelegramDeliveryRow {
  id: string;
  owner_user_id: string;
  email_message_id: string;
  channel: 'telegram';
  binding_id: string;
  authorization_version: number;
  status: TelegramDeliveryStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  claim_token: string | null;
  lease_expires_at: string | null;
  external_started: number;
  external_started_at: string | null;
  telegram_message_id: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TelegramDeliveryDetailRow extends TelegramDeliveryRow {
  subject: string;
  received_at: string;
}

export interface ClaimedTelegramDelivery {
  id: string;
  owner_user_id: string;
  email_message_id: string;
  binding_id: string;
  authorization_version: number;
  attempts: number;
  max_attempts: number;
  claim_token: string;
  telegram_chat_id: string;
  privacy_mode: number;
  summary_enabled: number;
  telegram_username: string | null;
  login_email: string;
  timezone: string;
  from_address: string;
  to_address: string;
  subject: string;
  received_at: string;
  snippet: string;
  attachment_count: number;
}

interface ClaimedTelegramDeliveryLease {
  id: string;
  owner_user_id: string;
  email_message_id: string;
  binding_id: string;
  authorization_version: number;
  attempts: number;
  max_attempts: number;
  claim_token: string;
}

const resultChanges = (result: D1Result<unknown> | undefined) => Number(result?.meta?.changes ?? 0);

export function telegramTableProbe(db: D1Database) {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'workspace_telegram_bindings',
      'workspace_telegram_bind_challenges',
      'workspace_telegram_updates',
      'workspace_telegram_deliveries',
      'workspace_telegram_rate_limits',
      'workspace_telegram_delivery_limits'
    )
  `).all<{ name: string }>();
}

export async function hasTelegramTables(db: D1Database) {
  try {
    const result = await telegramTableProbe(db);
    return new Set(result.results?.map(({ name }) => name)).size === 6;
  } catch {
    return false;
  }
}

export async function cleanupTelegramState(db: D1Database, now: string, maxRows = 500) {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(maxRows)));
  const nowMs = Date.parse(now);
  const referenceMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const challengeCutoff = new Date(referenceMs - 30 * 24 * 60 * 60 * 1000).toISOString();
  const deliveryCutoff = new Date(referenceMs - 180 * 24 * 60 * 60 * 1000).toISOString();
  const results = await db.batch([
    db.prepare(`
      UPDATE workspace_telegram_bind_challenges
      SET status = 'expired', updated_at = ?
      WHERE status = 'pending' AND expires_at <= ?
        AND id IN (
          SELECT id FROM workspace_telegram_bind_challenges
          WHERE status = 'pending' AND expires_at <= ?
          ORDER BY expires_at ASC, id ASC LIMIT ?
        )
    `).bind(now, now, now, safeLimit),
    db.prepare(`
      DELETE FROM workspace_telegram_bind_challenges
      WHERE status IN ('consumed', 'replaced', 'expired') AND updated_at < ?
        AND id IN (
          SELECT id FROM workspace_telegram_bind_challenges
          WHERE status IN ('consumed', 'replaced', 'expired') AND updated_at < ?
          ORDER BY updated_at ASC, id ASC LIMIT ?
        )
    `).bind(challengeCutoff, challengeCutoff, safeLimit),
    db.prepare(`
      DELETE FROM workspace_telegram_updates
      WHERE status IN ('processed', 'ignored') AND created_at < ?
        AND update_id IN (
          SELECT update_id FROM workspace_telegram_updates
          WHERE status IN ('processed', 'ignored') AND created_at < ?
          ORDER BY created_at ASC, update_id ASC LIMIT ?
        )
    `).bind(challengeCutoff, challengeCutoff, safeLimit),
    db.prepare(`
      DELETE FROM workspace_telegram_deliveries
      WHERE status IN ('sent', 'failed', 'cancelled') AND completed_at IS NOT NULL AND completed_at < ?
        AND id IN (
          SELECT id FROM workspace_telegram_deliveries
          WHERE status IN ('sent', 'failed', 'cancelled') AND completed_at IS NOT NULL AND completed_at < ?
          ORDER BY completed_at ASC, id ASC LIMIT ?
        )
    `).bind(deliveryCutoff, deliveryCutoff, safeLimit)
  ]);
  return {
    expiredChallenges: resultChanges(results[0]),
    deletedChallenges: resultChanges(results[1]),
    deletedUpdates: resultChanges(results[2]),
    deletedDeliveries: resultChanges(results[3])
  };
}

export function findTelegramBinding(db: D1Database, userId: string) {
  return db.prepare(`SELECT * FROM workspace_telegram_bindings WHERE user_id = ?`).bind(userId).first<TelegramBindingRow>();
}

export function findTelegramBindingByChat(db: D1Database, chatId: string) {
  return db.prepare(`
    SELECT * FROM workspace_telegram_bindings
    WHERE telegram_chat_id = ? AND state IN ('candidate', 'active')
    LIMIT 1
  `).bind(chatId).first<TelegramBindingRow>();
}

export async function createTelegramChallenge(
  db: D1Database,
  userId: string,
  challengeId: string,
  tokenHash: string,
  expiresAt: string
) {
  const now = nowIso();
  const result = await db.batch([
    db.prepare(`
      UPDATE workspace_telegram_bind_challenges
      SET status = 'replaced', replaced_at = ?, updated_at = ?
      WHERE owner_user_id = ? AND status = 'pending'
    `).bind(now, now, userId),
    db.prepare(`
      UPDATE workspace_telegram_bindings
      SET state = 'revoked', enabled = 0, telegram_user_id = NULL, telegram_chat_id = NULL,
        telegram_username = NULL, telegram_display_name = '', candidate_challenge_id = NULL,
        candidate_expires_at = NULL, revoked_at = ?, updated_at = ?
      WHERE user_id = ? AND state = 'candidate'
    `).bind(now, now, userId),
    db.prepare(`
      INSERT INTO workspace_telegram_bind_challenges
        (id, owner_user_id, token_hash, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?)
    `).bind(challengeId, userId, tokenHash, expiresAt, now, now)
  ]);
  return { replaced: resultChanges(result[0]), challengeId };
}

export interface TelegramWebhookBindingInput {
  updateId: string;
  processingToken: string;
  challengeHash: string;
  telegramUserId: string;
  telegramChatId: string;
  telegramUsername: string | null;
  telegramDisplayName: string;
  now: string;
}

export async function consumeTelegramChallenge(
  db: D1Database,
  input: TelegramWebhookBindingInput
): Promise<'bound' | 'duplicate' | 'invalid' | 'conflict'> {
  // The update row starts in `processing`; the same D1 batch consumes the
  // challenge, creates/replaces the candidate binding, and publishes the
  // final update status. A duplicate update cannot consume a challenge
  // because the processing-token predicate rejects a different token.
  const result = await db.batch([
    db.prepare(`
      INSERT INTO workspace_telegram_updates
        (update_id, processing_token, status, result_code, created_at, processed_at)
      VALUES (?, ?, 'processing', 'received', ?, ?)
      ON CONFLICT(update_id) DO NOTHING
    `).bind(input.updateId, input.processingToken, input.now, input.now),
    db.prepare(`
      UPDATE workspace_telegram_bind_challenges
      SET status = 'consumed', consumed_at = ?, updated_at = ?
      WHERE token_hash = ? AND status = 'pending' AND expires_at > ?
        AND NOT EXISTS (
          SELECT 1 FROM workspace_telegram_updates
          WHERE update_id = ? AND processing_token <> ?
        )
    `).bind(input.now, input.now, input.challengeHash, input.now, input.updateId, input.processingToken),
    db.prepare(`
      INSERT INTO workspace_telegram_bindings (
        user_id, binding_id, state, telegram_user_id, telegram_chat_id,
        telegram_username, telegram_display_name, candidate_challenge_id,
        candidate_expires_at, enabled, privacy_mode, summary_enabled,
        authorization_version, bound_at, created_at, updated_at
      )
      SELECT c.owner_user_id, lower(hex(randomblob(16))), 'candidate', ?, ?, ?, ?, c.id,
        c.expires_at, 0, 0, 0, 1, ?, ?, ?
      FROM workspace_telegram_bind_challenges AS c
      WHERE c.token_hash = ? AND c.status = 'consumed' AND c.consumed_at = ?
        AND NOT EXISTS (
          SELECT 1 FROM workspace_telegram_bindings AS target
          WHERE target.telegram_chat_id = ? AND target.state IN ('candidate', 'active')
        )
        AND NOT EXISTS (
          SELECT 1 FROM workspace_telegram_updates
          WHERE update_id = ? AND processing_token <> ?
        )
      ON CONFLICT(user_id) DO UPDATE SET
        state = CASE WHEN workspace_telegram_bindings.state = 'active' THEN workspace_telegram_bindings.state ELSE 'candidate' END,
        telegram_user_id = CASE WHEN workspace_telegram_bindings.state = 'active' THEN workspace_telegram_bindings.telegram_user_id ELSE excluded.telegram_user_id END,
        telegram_chat_id = CASE WHEN workspace_telegram_bindings.state = 'active' THEN workspace_telegram_bindings.telegram_chat_id ELSE excluded.telegram_chat_id END,
        telegram_username = CASE WHEN workspace_telegram_bindings.state = 'active' THEN workspace_telegram_bindings.telegram_username ELSE excluded.telegram_username END,
        telegram_display_name = CASE WHEN workspace_telegram_bindings.state = 'active' THEN workspace_telegram_bindings.telegram_display_name ELSE excluded.telegram_display_name END,
        candidate_challenge_id = CASE WHEN workspace_telegram_bindings.state = 'active' THEN workspace_telegram_bindings.candidate_challenge_id ELSE excluded.candidate_challenge_id END,
        candidate_expires_at = CASE WHEN workspace_telegram_bindings.state = 'active' THEN workspace_telegram_bindings.candidate_expires_at ELSE excluded.candidate_expires_at END,
        updated_at = excluded.updated_at
      WHERE workspace_telegram_bindings.state <> 'active'
    `).bind(
      input.telegramUserId,
      input.telegramChatId,
      input.telegramUsername,
      input.telegramDisplayName,
      input.now,
      input.now,
      input.now,
      input.challengeHash,
      input.now,
      input.telegramChatId,
      input.updateId,
      input.processingToken
    ),
    db.prepare(`
      UPDATE workspace_telegram_updates
      SET status = 'processed', result_code = 'bound', processed_at = ?
      WHERE update_id = ? AND processing_token = ?
    `).bind(input.now, input.updateId, input.processingToken)
  ]);
  if (resultChanges(result[0]) === 0) return 'duplicate';
  if (resultChanges(result[1]) === 0) {
    await db.prepare(`UPDATE workspace_telegram_updates SET status = 'ignored', result_code = 'invalid_challenge' WHERE update_id = ? AND processing_token = ?`)
      .bind(input.updateId, input.processingToken).run();
    return 'invalid';
  }
  if (resultChanges(result[2]) === 0) {
    await db.prepare(`UPDATE workspace_telegram_updates SET status = 'ignored', result_code = 'binding_conflict' WHERE update_id = ? AND processing_token = ?`)
      .bind(input.updateId, input.processingToken).run();
    return 'conflict';
  }
  return 'bound';
}

export async function recordTelegramIgnoredUpdate(db: D1Database, updateId: string, resultCode: string) {
  const now = nowIso();
  const result = await db.prepare(`
    INSERT INTO workspace_telegram_updates
      (update_id, processing_token, status, result_code, created_at, processed_at)
    VALUES (?, ?, 'ignored', ?, ?, ?)
    ON CONFLICT(update_id) DO NOTHING
  `).bind(updateId, crypto.randomUUID(), resultCode, now, now).run();
  return resultChanges(result) > 0;
}

export async function activateTelegramBinding(db: D1Database, userId: string, now = nowIso()) {
  const result = await db.prepare(`
    UPDATE workspace_telegram_bindings
    SET state = 'active', enabled = 0, confirmed_at = ?, candidate_challenge_id = NULL,
      candidate_expires_at = NULL, updated_at = ?
    WHERE user_id = ? AND state = 'candidate' AND telegram_chat_id IS NOT NULL
      AND (candidate_expires_at IS NULL OR candidate_expires_at > ?)
  `).bind(now, now, userId, now).run();
  return resultChanges(result) > 0;
}

export async function updateTelegramSettings(
  db: D1Database,
  userId: string,
  settings: { enabled?: boolean; privacyMode?: boolean; summaryEnabled?: boolean }
) {
  const current = await findTelegramBinding(db, userId);
  if (!current || current.state !== 'active') return null;
  const now = nowIso();
  const enabled = settings.enabled ?? current.enabled === 1;
  const privacyMode = settings.privacyMode ?? current.privacy_mode === 1;
  const summaryEnabled = settings.summaryEnabled ?? current.summary_enabled === 1;
  await db.batch([
    db.prepare(`
      UPDATE workspace_telegram_bindings
      SET enabled = ?, privacy_mode = ?, summary_enabled = ?, updated_at = ?
      WHERE user_id = ? AND state = 'active'
    `).bind(enabled ? 1 : 0, privacyMode ? 1 : 0, summaryEnabled ? 1 : 0, now, userId),
    ...(enabled ? [] : [db.prepare(`
      UPDATE workspace_telegram_deliveries
      SET status = 'cancelled', claim_token = NULL, lease_expires_at = NULL,
        completed_at = ?, updated_at = ?
      WHERE owner_user_id = ? AND status IN ('pending', 'retryable', 'processing') AND external_started = 0
    `).bind(now, now, userId)])
  ]);
  return findTelegramBinding(db, userId);
}

export async function revokeTelegramBinding(db: D1Database, userId: string) {
  const now = nowIso();
  const version = await db.prepare(`SELECT authorization_version FROM workspace_telegram_bindings WHERE user_id = ?`).bind(userId).first<{ authorization_version: number }>();
  if (!version) return false;
  const nextVersion = Math.max(1, Number(version.authorization_version) + 1);
  const results = await db.batch([
    db.prepare(`
      UPDATE workspace_telegram_bindings
      SET state = 'revoked', enabled = 0, telegram_user_id = NULL, telegram_chat_id = NULL,
        telegram_username = NULL, telegram_display_name = '', authorization_version = ?,
        revoked_at = ?, updated_at = ?
      WHERE user_id = ?
    `).bind(nextVersion, now, now, userId),
    db.prepare(`
      UPDATE workspace_telegram_deliveries
      SET status = 'cancelled', claim_token = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
      WHERE owner_user_id = ? AND status IN ('pending', 'retryable', 'processing') AND external_started = 0
    `).bind(now, now, userId)
  ]);
  return resultChanges(results[0]) > 0;
}

export function insertTelegramDeliveryIfEligible(
  db: D1Database,
  input: { deliveryId: string; ownerUserId: string; emailMessageId: string; nextAttemptAt: string; now: string }
) {
  return db.prepare(`
    INSERT INTO workspace_telegram_deliveries (
      id, owner_user_id, email_message_id, channel, binding_id,
      authorization_version, status, attempts, max_attempts, next_attempt_at,
      created_at, updated_at
    )
    SELECT ?, e.owner_user_id, e.id, 'telegram', b.binding_id,
      b.authorization_version, 'pending', 0, 5, ?, ?, ?
    FROM email_messages AS e
    JOIN workspace_users AS u ON u.id = e.owner_user_id
    JOIN workspace_telegram_bindings AS b
      ON b.user_id = e.owner_user_id AND b.state = 'active' AND b.enabled = 1
    LEFT JOIN workspace_email_states AS s
      ON s.user_id = e.owner_user_id AND s.email_message_id = e.id
    WHERE e.id = ? AND e.owner_user_id = ? AND lower(e."to") = lower(u.login_email)
      AND s.deleted_at IS NULL
    ON CONFLICT(channel, owner_user_id, email_message_id) DO NOTHING
  `).bind(input.deliveryId, input.nextAttemptAt, input.now, input.now, input.emailMessageId, input.ownerUserId);
}

export async function listTelegramDeliveries(db: D1Database, userId: string, limit = 20) {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const result = await db.prepare(`
    SELECT d.*, e.subject, COALESCE(e.created_at, e."timestamp") AS received_at
    FROM workspace_telegram_deliveries AS d
    JOIN email_messages AS e ON e.id = d.email_message_id AND e.owner_user_id = d.owner_user_id
    WHERE d.owner_user_id = ?
    ORDER BY d.created_at DESC, d.id DESC
    LIMIT ?
  `).bind(userId, safeLimit).all<TelegramDeliveryDetailRow>();
  return result.results ?? [];
}

export async function retryTelegramDelivery(db: D1Database, userId: string, deliveryId: string) {
  const now = nowIso();
  const result = await db.prepare(`
    UPDATE workspace_telegram_deliveries
    SET status = 'pending', attempts = 0, next_attempt_at = ?, claim_token = NULL, lease_expires_at = NULL,
      external_started = 0, external_started_at = NULL, last_error_code = NULL,
      last_error_at = NULL, updated_at = ?
    WHERE id = ? AND owner_user_id = ? AND status IN ('failed', 'retryable', 'unknown_delivery')
  `).bind(now, now, deliveryId, userId).run();
  return resultChanges(result) > 0;
}

export async function claimTelegramDelivery(db: D1Database, now: string, leaseUntil: string) {
  const claimToken = crypto.randomUUID();
  const row = await db.prepare(`
    UPDATE workspace_telegram_deliveries
    SET status = 'processing', attempts = attempts + 1, claim_token = ?, lease_expires_at = ?,
      external_started = 0, external_started_at = NULL, updated_at = ?
    WHERE id = (
      SELECT id FROM workspace_telegram_deliveries
      WHERE (status IN ('pending', 'retryable') AND next_attempt_at <= ? AND attempts < max_attempts)
         OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND external_started = 0 AND attempts < max_attempts)
      ORDER BY next_attempt_at ASC, created_at ASC, id ASC
      LIMIT 1
    )
    RETURNING id, owner_user_id, email_message_id, binding_id, authorization_version,
      attempts, max_attempts, claim_token
  `).bind(claimToken, leaseUntil, now, now, now).first<ClaimedTelegramDeliveryLease>();
  if (!row) return null;
  const detail = await db.prepare(`
    SELECT d.id, d.owner_user_id, d.email_message_id, d.binding_id, d.authorization_version,
      d.attempts, d.max_attempts, d.claim_token, b.telegram_chat_id, b.privacy_mode,
      b.summary_enabled, b.telegram_username, u.login_email, u.timezone,
      e."from" AS from_address, e."to" AS to_address, e.subject,
      COALESCE(e.created_at, e."timestamp") AS received_at, e.snippet,
      (SELECT COUNT(*) FROM workspace_attachments AS a WHERE a.message_id = e.id AND a.relation_type = 'inbound') AS attachment_count
    FROM workspace_telegram_deliveries AS d
    JOIN workspace_telegram_bindings AS b
      ON b.user_id = d.owner_user_id AND b.binding_id = d.binding_id
      AND b.state = 'active' AND b.enabled = 1
      AND b.authorization_version = d.authorization_version
    JOIN workspace_users AS u ON u.id = d.owner_user_id
    JOIN email_messages AS e ON e.id = d.email_message_id AND e.owner_user_id = d.owner_user_id
      AND lower(e."to") = lower(u.login_email)
    LEFT JOIN workspace_email_states AS s
      ON s.user_id = d.owner_user_id AND s.email_message_id = e.id
    WHERE d.id = ? AND d.claim_token = ? AND s.deleted_at IS NULL
  `).bind(row.id, row.claim_token).first<ClaimedTelegramDelivery>();
  if (!detail) {
    await markTelegramCancelled(db, row.id, row.claim_token, 'binding_not_active');
    return null;
  }
  return detail;
}

export async function markTelegramCancelled(db: D1Database, deliveryId: string, claimToken: string, errorCode = 'binding_not_active') {
  const now = nowIso();
  await db.prepare(`
    UPDATE workspace_telegram_deliveries
    SET status = 'cancelled', claim_token = NULL, lease_expires_at = NULL,
      last_error_code = ?, last_error_at = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND claim_token = ? AND status = 'processing'
  `).bind(errorCode, now, now, now, deliveryId, claimToken).run();
}

export async function markTelegramExternalStarted(db: D1Database, deliveryId: string, claimToken: string) {
  const now = nowIso();
  const result = await db.prepare(`
    UPDATE workspace_telegram_deliveries
    SET external_started = 1, external_started_at = ?, updated_at = ?
    WHERE id = ? AND claim_token = ? AND status = 'processing'
      AND EXISTS (
        SELECT 1 FROM workspace_telegram_bindings AS b
        WHERE b.user_id = workspace_telegram_deliveries.owner_user_id
          AND b.binding_id = workspace_telegram_deliveries.binding_id
          AND b.state = 'active' AND b.enabled = 1
          AND b.authorization_version = workspace_telegram_deliveries.authorization_version
      )
      AND EXISTS (
        SELECT 1 FROM email_messages AS e
        JOIN workspace_users AS u ON u.id = workspace_telegram_deliveries.owner_user_id
        LEFT JOIN workspace_email_states AS s
          ON s.user_id = workspace_telegram_deliveries.owner_user_id AND s.email_message_id = e.id
        WHERE e.id = workspace_telegram_deliveries.email_message_id
          AND e.owner_user_id = workspace_telegram_deliveries.owner_user_id
          AND lower(e."to") = lower(u.login_email) AND s.deleted_at IS NULL
      )
  `).bind(now, now, deliveryId, claimToken).run();
  return resultChanges(result) > 0;
}

export async function markTelegramSent(db: D1Database, input: { deliveryId: string; claimToken: string; messageId: string }) {
  const now = nowIso();
  const result = await db.batch([
    db.prepare(`
      UPDATE workspace_telegram_deliveries
      SET status = 'sent', claim_token = NULL, lease_expires_at = NULL, telegram_message_id = ?,
        completed_at = ?, last_error_code = NULL, last_error_at = NULL, updated_at = ?
      WHERE id = ? AND claim_token = ? AND status = 'processing'
    `).bind(input.messageId, now, now, input.deliveryId, input.claimToken),
    db.prepare(`
      UPDATE workspace_telegram_bindings
      SET last_sent_at = ?, last_error_code = NULL, last_error_at = NULL, updated_at = ?
      WHERE binding_id = (SELECT binding_id FROM workspace_telegram_deliveries WHERE id = ?)
    `).bind(now, now, input.deliveryId)
  ]);
  if (resultChanges(result[0]) === 0) throw new Error('TELEGRAM_DELIVERY_FINALIZE_FAILED');
}

export async function markTelegramUnknown(db: D1Database, deliveryId: string, claimToken: string, errorCode = 'unknown_delivery') {
  const now = nowIso();
  const result = await db.prepare(`
    UPDATE workspace_telegram_deliveries
    SET status = 'unknown_delivery', claim_token = NULL, lease_expires_at = NULL,
      last_error_code = ?, last_error_at = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND claim_token = ? AND status = 'processing'
  `).bind(errorCode, now, now, now, deliveryId, claimToken).run();
  if (resultChanges(result) === 0) throw new Error('TELEGRAM_DELIVERY_UNKNOWN_FINALIZE_FAILED');
}

export async function markTelegramFailure(
  db: D1Database,
  input: { deliveryId: string; claimToken: string; status: 'retryable' | 'failed'; errorCode: string; nextAttemptAt?: string }
) {
  const now = nowIso();
  const result = await db.batch([
    db.prepare(`
      UPDATE workspace_telegram_deliveries
      SET status = ?, next_attempt_at = ?, claim_token = NULL, lease_expires_at = NULL,
        external_started = 0, external_started_at = NULL, last_error_code = ?, last_error_at = ?,
        completed_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END, updated_at = ?
      WHERE id = ? AND claim_token = ? AND status = 'processing'
    `).bind(
      input.status,
      input.nextAttemptAt ?? now,
      input.errorCode,
      now,
      input.status,
      input.status === 'failed' ? now : null,
      now,
      input.deliveryId,
      input.claimToken
    ),
    db.prepare(`
      UPDATE workspace_telegram_bindings
      SET last_error_code = ?, last_error_at = ?, updated_at = ?
      WHERE binding_id = (SELECT binding_id FROM workspace_telegram_deliveries WHERE id = ?)
    `).bind(input.errorCode, now, now, input.deliveryId)
  ]);
  if (resultChanges(result[0]) === 0) throw new Error('TELEGRAM_DELIVERY_FINALIZE_FAILED');
}

export async function markTelegramStaleUnknown(db: D1Database, now: string) {
  const result = await db.prepare(`
    UPDATE workspace_telegram_deliveries
    SET status = 'unknown_delivery', claim_token = NULL, lease_expires_at = NULL,
      last_error_code = 'worker_interrupted_after_send', last_error_at = ?, completed_at = ?, updated_at = ?
    WHERE status = 'processing' AND external_started = 1
      AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
  `).bind(now, now, now, now).run();
  return resultChanges(result);
}

export async function reserveTelegramDeliveryScope(db: D1Database, scope: string, now: string, nextAllowedAt: string) {
  const result = await db.prepare(`
    INSERT INTO workspace_telegram_delivery_limits (scope, next_allowed_at, cooldown_until, updated_at)
    VALUES (?, ?, NULL, ?)
    ON CONFLICT(scope) DO UPDATE SET next_allowed_at = excluded.next_allowed_at, updated_at = excluded.updated_at
      WHERE (workspace_telegram_delivery_limits.cooldown_until IS NULL OR workspace_telegram_delivery_limits.cooldown_until <= ?)
        AND (workspace_telegram_delivery_limits.next_allowed_at IS NULL OR workspace_telegram_delivery_limits.next_allowed_at <= ?)
  `).bind(scope, nextAllowedAt, now, now, now).run();
  return resultChanges(result) > 0;
}

export async function setTelegramDeliveryCooldown(db: D1Database, scope: string, cooldownUntil: string) {
  const now = nowIso();
  await db.prepare(`
    INSERT INTO workspace_telegram_delivery_limits (scope, cooldown_until, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET cooldown_until = excluded.cooldown_until, updated_at = excluded.updated_at
  `).bind(scope, cooldownUntil, now).run();
}

export async function consumeTelegramActionLimit(
  db: D1Database,
  userId: string,
  action: string,
  nowMs = Date.now(),
  windowMs = 60 * 60 * 1000,
  maxAttempts = 10
) {
  const resetAt = nowMs + windowMs;
  const result = await db.prepare(`
    INSERT INTO workspace_telegram_rate_limits (user_id, action, attempt_count, window_started_at, reset_at, updated_at)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(user_id, action) DO UPDATE SET
      attempt_count = CASE WHEN workspace_telegram_rate_limits.reset_at <= ? THEN 1 ELSE workspace_telegram_rate_limits.attempt_count + 1 END,
      reset_at = excluded.reset_at,
      updated_at = excluded.updated_at,
      window_started_at = excluded.window_started_at
    WHERE workspace_telegram_rate_limits.reset_at <= ?
       OR workspace_telegram_rate_limits.attempt_count < ?
  `).bind(userId, action, nowMs, resetAt, nowMs, nowMs, nowMs, maxAttempts).run();
  if (resultChanges(result) > 0) return { allowed: true, retryAfterSeconds: 0 };
  const row = await db.prepare(`SELECT reset_at FROM workspace_telegram_rate_limits WHERE user_id = ? AND action = ?`).bind(userId, action).first<{ reset_at: number }>();
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((Number(row?.reset_at ?? nowMs + windowMs) - nowMs) / 1000)) };
}
