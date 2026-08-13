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
