import type { MailInboxCategory } from '$lib/domain/mail';

export interface MailAiJob {
  owner_user_id: string;
  message_id: string;
  consent_token: string;
  claim_token: string;
  attempted: number;
}

// Evaluate consent and visibility in SQL at each mutation, including concurrent revocation.
const authorized = `EXISTS (
  SELECT 1 FROM workspace_settings settings JOIN email_messages e ON e.owner_user_id = settings.user_id
  LEFT JOIN workspace_email_states state ON state.user_id = e.owner_user_id AND state.email_message_id = e.id
  WHERE settings.user_id = mail_ai_jobs.owner_user_id AND e.id = mail_ai_jobs.message_id
    AND json_extract(settings.settings_json, '$.mailAi.enabled') = 1
    AND json_extract(settings.settings_json, '$.mailAi.automaticClassification') = 1
    AND json_extract(settings.settings_json, '$.mailAi.classificationConsent') = mail_ai_jobs.consent_token
    AND e.inbox_category_v2 IS NULL AND state.deleted_at IS NULL AND state.quarantined_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM blocked_senders b WHERE b.owner_user_id = e.owner_user_id
      AND b.email = lower(trim(CASE WHEN instr(e."from", '<') > 0 AND instr(e."from", '>') > instr(e."from", '<')
        THEN substr(e."from", instr(e."from", '<') + 1, instr(e."from", '>') - instr(e."from", '<') - 1) ELSE e."from" END)))
)`;

/** Optional statement for the inbound transaction; never backfills existing messages. */
export function insertMailAiJobIfEligible(db: D1Database, owner: string, id: string, now = Date.now()) {
  return db.prepare(`INSERT OR IGNORE INTO mail_ai_jobs (owner_user_id, message_id, consent_token, created_at)
    SELECT ?, ?, json_extract(settings_json, '$.mailAi.classificationConsent'), ? FROM workspace_settings
    WHERE user_id = ? AND json_extract(settings_json, '$.mailAi.enabled') = 1
      AND json_extract(settings_json, '$.mailAi.automaticClassification') = 1
      AND json_extract(settings_json, '$.mailAi.classificationConsent') IS NOT NULL`)
    .bind(owner, id, now, owner);
}

export function claimMailAiJob(db: D1Database, now = Date.now()) {
  return db.prepare(`UPDATE mail_ai_jobs SET status = 'processing', claim_token = ?, lease_until = ?
    WHERE rowid = (SELECT rowid FROM mail_ai_jobs
      WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'processing' AND lease_until <= ?)
      ORDER BY created_at, owner_user_id, message_id LIMIT 1)
    RETURNING owner_user_id, message_id, consent_token, claim_token, attempted`)
    .bind(crypto.randomUUID(), now + 60_000, now, now).first<MailAiJob>();
}

export function isMailAiJobAuthorized(db: D1Database, job: MailAiJob) {
  return db.prepare(`SELECT 1 AS allowed FROM mail_ai_jobs WHERE owner_user_id = ? AND message_id = ?
    AND claim_token = ? AND status = 'processing' AND ${authorized}`)
    .bind(job.owner_user_id, job.message_id, job.claim_token).first<{ allowed: number }>();
}

export async function reserveMailAiJobAttempt(db: D1Database, job: MailAiJob) {
  const row = await db.prepare(`UPDATE mail_ai_jobs SET attempted = 1
    WHERE owner_user_id = ? AND message_id = ? AND claim_token = ? AND status = 'processing'
      AND attempted = 0 AND lease_until > ? AND ${authorized} RETURNING message_id`)
    .bind(job.owner_user_id, job.message_id, job.claim_token, Date.now()).first();
  return Boolean(row);
}

export function finishMailAiJob(db: D1Database, job: MailAiJob, status: 'pending' | 'done' | 'failed' | 'cancelled', nextAttemptAt = 0) {
  return db.prepare(`UPDATE mail_ai_jobs SET status = ?, lease_until = 0, next_attempt_at = ?
    WHERE owner_user_id = ? AND message_id = ? AND claim_token = ? AND status = 'processing'`)
    .bind(status, nextAttemptAt, job.owner_user_id, job.message_id, job.claim_token).run();
}

export function applyMailAiJobCategory(db: D1Database, job: MailAiJob, category: MailInboxCategory) {
  return db.prepare(`UPDATE email_messages SET ai_inbox_category = ? WHERE owner_user_id = ? AND id = ?
    AND inbox_category_v2 IS NULL AND EXISTS (SELECT 1 FROM mail_ai_jobs
      WHERE owner_user_id = ? AND message_id = ? AND claim_token = ? AND status = 'processing' AND ${authorized})`)
    .bind(category, job.owner_user_id, job.message_id, job.owner_user_id, job.message_id, job.claim_token).run();
}
