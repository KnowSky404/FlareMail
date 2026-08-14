export interface InboundMessageInsert {
  id: string;
  messageId: string | null;
  from: string;
  to: string;
  cc: string;
  subject: string;
  timestamp: string;
  snippet: string;
  textBody: string;
  htmlBody: string;
  inReplyTo: string | null;
  references: string | null;
  threadKey: string;
  dedupeKey: string;
  rawKey: string;
  rawSize: number;
  ownerUserId: string | null;
}

export interface InboundIngestClaim {
  dedupeKey: string;
  storageId: string;
  claimToken: string;
  rawKey: string;
  status: 'processing' | 'completed';
}

const claimStorageId = () => crypto.randomUUID().replaceAll('-', '');

export async function claimInboundIngest(db: D1Database, dedupeKey: string, rawKeyForStorage: (storageId: string) => string, staleAfterMs = 15 * 60 * 1000): Promise<InboundIngestClaim | null> {
  const now = new Date().toISOString();
  const storageId = claimStorageId();
  const claimToken = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO workspace_inbound_ingest_claims (dedupe_key, storage_id, claim_token, raw_key, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'processing', ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING
  `).bind(dedupeKey, storageId, claimToken, rawKeyForStorage(storageId), now, now).run();
  const current = await db.prepare(`
    SELECT dedupe_key, storage_id, claim_token, raw_key, status, updated_at
    FROM workspace_inbound_ingest_claims WHERE dedupe_key = ?
  `).bind(dedupeKey).first<{ dedupe_key: string; storage_id: string; claim_token: string; raw_key: string; status: 'processing' | 'completed'; updated_at: string }>();
  if (!current) throw new Error('Inbound ingest claim was not persisted.');
  const mapped = { dedupeKey: current.dedupe_key, storageId: current.storage_id, claimToken: current.claim_token, rawKey: current.raw_key, status: current.status } as InboundIngestClaim;
  if (current.status === 'completed') return mapped;
  if (current.claim_token === claimToken) return mapped;

  const staleBefore = new Date(Date.now() - staleAfterMs).toISOString();
  if (current.updated_at > staleBefore) return null;
  const replacementStorageId = claimStorageId();
  const replacementToken = crypto.randomUUID();
  const replaced = await db.prepare(`
    UPDATE workspace_inbound_ingest_claims
    SET storage_id = ?, claim_token = ?, raw_key = ?, updated_at = ?, completed_at = NULL
    WHERE dedupe_key = ? AND status = 'processing' AND updated_at <= ?
  `).bind(replacementStorageId, replacementToken, rawKeyForStorage(replacementStorageId), now, dedupeKey, staleBefore).run();
  if (replaced.meta?.changes === 0) return null;
  return { dedupeKey, storageId: replacementStorageId, claimToken: replacementToken, rawKey: rawKeyForStorage(replacementStorageId), status: 'processing' };
}

export async function completeInboundIngestClaim(db: D1Database, dedupeKey: string, claimToken: string) {
  const now = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE workspace_inbound_ingest_claims SET status = 'completed', completed_at = ?, updated_at = ?
    WHERE dedupe_key = ? AND claim_token = ? AND status = 'processing'
  `).bind(now, now, dedupeKey, claimToken).run();
  if (result.meta?.changes === 0) throw new Error('Inbound ingest claim was lost before completion.');
}

export async function releaseInboundIngestClaim(db: D1Database, dedupeKey: string, claimToken: string) {
  await db.prepare(`DELETE FROM workspace_inbound_ingest_claims WHERE dedupe_key = ? AND claim_token = ? AND status = 'processing'`).bind(dedupeKey, claimToken).run();
}

export async function findInboundByDedupeKey(db: D1Database, dedupeKey: string) {
  return db.prepare(`SELECT id, raw_key FROM email_messages WHERE dedupe_key = ?`)
    .bind(dedupeKey).first<{ id: string; raw_key: string }>();
}

export async function findInboundOwnerId(db: D1Database, recipient: string) {
  const row = await db.prepare(`
    SELECT id FROM workspace_users
    WHERE lower(login_email) = lower(?) OR lower(email) = lower(?)
    ORDER BY CASE WHEN lower(login_email) = lower(?) THEN 0 ELSE 1 END, created_at ASC
    LIMIT 1
  `).bind(recipient, recipient, recipient).first<{ id: string }>();
  return row?.id ?? null;
}

export function insertInboundMessage(db: D1Database, message: InboundMessageInsert) {
  return db.prepare(`
    INSERT INTO email_messages (
      id, message_id, "from", "to", cc, subject, "timestamp", snippet,
      text_body, html_body, in_reply_to, "references", thread_key,
      direction, dedupe_key, idempotency_key, raw_key, raw_size, owner_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?)
  `).bind(
    message.id,
    message.messageId,
    message.from,
    message.to,
    message.cc,
    message.subject,
    message.timestamp,
    message.snippet,
    message.textBody,
    message.htmlBody,
    message.inReplyTo,
    message.references,
    message.threadKey,
    message.dedupeKey,
    message.dedupeKey,
    message.rawKey,
    message.rawSize,
    message.ownerUserId
  );
}

export async function findOwnedInboundMessage(
  db: D1Database,
  userId: string,
  messageId: string
) {
  return db.prepare(`
    SELECT id, message_id, "from", "to", cc, subject, "timestamp", snippet,
      text_body, html_body, in_reply_to, "references", thread_key,
      raw_key, raw_size, created_at
    FROM email_messages
    WHERE id = ? AND owner_user_id = ?
  `).bind(messageId, userId).first<{
    id: string;
    message_id: string | null;
    from: string;
    to: string;
    cc: string;
    subject: string;
    timestamp: string;
    snippet: string;
    text_body: string;
    html_body: string;
    in_reply_to: string | null;
    references: string | null;
    thread_key: string;
    raw_key: string;
    raw_size: number;
    created_at: string;
  }>();
}

export async function findOwnedInboundState(db: D1Database, userId: string, messageId: string) {
  return db.prepare(`
    SELECT e.id AS email_id, e."from", e."to", e.subject, e."timestamp", e.snippet,
      e.message_id, e.in_reply_to, e."references", e.thread_key, e.text_body,
      COALESCE(s.is_read, 0) AS is_read, COALESCE(s.is_starred, 0) AS is_starred
    FROM email_messages AS e LEFT JOIN workspace_email_states AS s
      ON s.user_id = ? AND s.email_message_id = e.id
    WHERE e.id = ? AND e.owner_user_id = ? AND s.deleted_at IS NULL
  `).bind(userId, messageId, userId).first<{
    email_id: string; from: string; to: string; subject: string; timestamp: string; snippet: string;
    message_id: string | null; in_reply_to: string | null; references: string | null; thread_key: string | null;
    text_body: string; is_read: number; is_starred: number;
  }>();
}
