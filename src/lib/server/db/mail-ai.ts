import { MAIL_AI_VERSION } from '$lib/domain/mail/ai';

export interface MailAiKey { owner: string; kind: 'inbound' | 'workspace'; id: string }
export interface MailAiRow {
  fingerprint: string; model: string; schema_version: number;
  status: 'processing' | 'ready' | 'failed'; result_json: string | null;
  lease_until: number; created_at: number; updated_at: number;
}
export function readMailAi(db: D1Database, key: MailAiKey) {
  return db.prepare(`SELECT fingerprint, model, schema_version, status, result_json, lease_until, created_at, updated_at
    FROM mail_ai_analyses WHERE owner_user_id = ? AND message_kind = ? AND message_id = ?`)
    .bind(key.owner, key.kind, key.id).first<MailAiRow>();
}

/** Atomic claim plus existence check prevents deletion races and duplicate bills. */
export async function claimMailAi(db: D1Database, key: MailAiKey, fingerprint: string, model: string, regenerate: boolean, now = Date.now()) {
  const token = crypto.randomUUID();
  const sender = key.kind === 'inbound' ? 'e."from"' : 'from_email';
  const address = `lower(trim(CASE WHEN instr(${sender}, '<') > 0 AND instr(${sender}, '>') > instr(${sender}, '<')
    THEN substr(${sender}, instr(${sender}, '<') + 1, instr(${sender}, '>') - instr(${sender}, '<') - 1) ELSE ${sender} END))`;
  const exists = key.kind === 'inbound'
    ? `SELECT 1 FROM email_messages e LEFT JOIN workspace_email_states s ON s.user_id = e.owner_user_id AND s.email_message_id = e.id
       WHERE e.owner_user_id = ? AND e.id = ? AND s.deleted_at IS NULL AND s.quarantined_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM blocked_senders b WHERE b.owner_user_id = e.owner_user_id AND b.email = ${address})`
    : `SELECT 1 FROM workspace_messages WHERE user_id = ? AND id = ? AND folder = 'inbox' AND deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM blocked_senders b WHERE b.owner_user_id = workspace_messages.user_id AND b.email = ${address})`;
  const row = await db.prepare(`INSERT INTO mail_ai_analyses
    (owner_user_id, message_kind, message_id, fingerprint, model, schema_version, status, result_json, claim_token, lease_until, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, 'processing', NULL, ?, ?, ?, ? WHERE EXISTS (${exists})
    ON CONFLICT(owner_user_id, message_kind, message_id) DO UPDATE SET
      fingerprint = excluded.fingerprint, model = excluded.model, schema_version = excluded.schema_version,
      status = 'processing', result_json = NULL, claim_token = excluded.claim_token,
      lease_until = excluded.lease_until, updated_at = excluded.updated_at
    WHERE mail_ai_analyses.lease_until <= ? AND mail_ai_analyses.updated_at <= ?
      AND (? OR mail_ai_analyses.fingerprint <> excluded.fingerprint OR mail_ai_analyses.status <> 'ready')
    RETURNING claim_token`).bind(key.owner, key.kind, key.id, fingerprint, model, MAIL_AI_VERSION,
      token, now + 60000, now, now, key.owner, key.id, now, now - 30000, regenerate ? 1 : 0)
    .first<{ claim_token: string }>();
  return row?.claim_token ?? null;
}

export async function consumeMailAiQuota(db: D1Database, owner: string, now = Date.now()) {
  const row = await db.prepare(`INSERT INTO mail_ai_rate_limits (owner_user_id, attempts, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(owner_user_id) DO UPDATE SET
      attempts = CASE WHEN mail_ai_rate_limits.reset_at <= ? THEN 1 ELSE MIN(mail_ai_rate_limits.attempts + 1, 31) END,
      reset_at = CASE WHEN mail_ai_rate_limits.reset_at <= ? THEN excluded.reset_at ELSE mail_ai_rate_limits.reset_at END
    RETURNING attempts`).bind(owner, now + 3600000, now, now).first<{ attempts: number }>();
  return Boolean(row && row.attempts <= 30);
}

export function finishMailAi(db: D1Database, key: MailAiKey, token: string, result: string | null, now = Date.now()) {
  return db.prepare(`UPDATE mail_ai_analyses SET status = ?, result_json = ?, lease_until = 0, updated_at = ?
    WHERE owner_user_id = ? AND message_kind = ? AND message_id = ? AND claim_token = ? AND status = 'processing'`)
    .bind(result === null ? 'failed' : 'ready', result, now, key.owner, key.kind, key.id, token).run();
}
