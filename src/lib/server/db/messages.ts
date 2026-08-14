import type { WorkspaceCapabilities, WorkspaceInboundRow, WorkspaceMessageRow } from '$lib/server/workspace/shared';

export async function listMessages(db: D1Database, userId: string) {
  return db.prepare(`
    SELECT id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at, labels_json, is_read, is_starred,
      message_id, in_reply_to, "references", thread_key, cc, idempotency_key
    FROM workspace_messages WHERE user_id = ? ORDER BY sent_at DESC, created_at DESC
  `).bind(userId).all<WorkspaceMessageRow>();
}

export async function listInboundMessages(db: D1Database, userId: string, _loginEmail: string, _profileEmail: string, capabilities: WorkspaceCapabilities) {
  if (!capabilities.inboundStates) return { results: [] as WorkspaceInboundRow[] };
  return db.prepare(`
    SELECT e.id AS email_id, e."from", e."to", e.subject, e."timestamp", e.snippet,
      e.message_id, e.in_reply_to, e."references", e.thread_key, e.text_body,
      COALESCE(s.is_read, 0) AS is_read, COALESCE(s.is_starred, 0) AS is_starred
    FROM email_messages AS e LEFT JOIN workspace_email_states AS s
      ON s.user_id = ? AND s.email_message_id = e.id
    WHERE e.owner_user_id = ? AND s.deleted_at IS NULL
    ORDER BY e."timestamp" DESC, e.id DESC
  `).bind(userId, userId).all<WorkspaceInboundRow>();
}

export function insertMessage(db: D1Database, payload: ReturnType<typeof import('$lib/server/workspace/shared').serializeMessageForInsert>) {
  return db.prepare(`
    INSERT INTO workspace_messages (user_id, id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at, labels_json, is_read, is_starred,
      message_id, in_reply_to, "references", thread_key, cc, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(payload.userId, payload.id, payload.folder, payload.fromName, payload.fromEmail, payload.toName, payload.toEmail,
    payload.subject, payload.preview, payload.body, payload.sentAt, payload.labelsJson, payload.isRead, payload.isStarred,
    payload.messageId, payload.inReplyTo, payload.references, payload.threadKey, payload.cc, payload.idempotencyKey,
    payload.createdAt, payload.updatedAt);
}

export async function findMessageByIdempotencyKey(db: D1Database, userId: string, idempotencyKey: string) {
  return db.prepare(`
    SELECT id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at,
      labels_json, is_read, is_starred, message_id, in_reply_to, "references", thread_key, cc, idempotency_key
    FROM workspace_messages WHERE user_id = ? AND idempotency_key = ?
  `).bind(userId, idempotencyKey).first<WorkspaceMessageRow>();
}

export async function findOwnedWorkspaceMessage(db: D1Database, userId: string, messageId: string) {
  return db.prepare(`
    SELECT id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at,
      labels_json, is_read, is_starred, message_id, in_reply_to, "references", thread_key, cc, idempotency_key
    FROM workspace_messages WHERE user_id = ? AND id = ?
  `).bind(userId, messageId).first<WorkspaceMessageRow>();
}

export function updateMessageFlags(db: D1Database, userId: string, messageId: string, read: boolean, starred: boolean, timestamp: string) {
  return db.prepare(`UPDATE workspace_messages SET is_read = ?, is_starred = ?, updated_at = ? WHERE user_id = ? AND id = ?`)
    .bind(read ? 1 : 0, starred ? 1 : 0, timestamp, userId, messageId);
}

export function deleteMessage(db: D1Database, userId: string, messageId: string) {
  return db.prepare(`DELETE FROM workspace_messages WHERE user_id = ? AND id = ?`).bind(userId, messageId);
}

export function upsertInboundState(db: D1Database, userId: string, emailMessageId: string, read: boolean, starred: boolean, timestamp: string, deletedAt: string | null = null) {
  return db.prepare(`
    INSERT INTO workspace_email_states (id, user_id, email_message_id, is_read, is_starred, deleted_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, email_message_id) DO UPDATE SET
      is_read = excluded.is_read, is_starred = excluded.is_starred, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at
  `).bind(crypto.randomUUID(), userId, emailMessageId, read ? 1 : 0, starred ? 1 : 0, deletedAt, timestamp, timestamp);
}

export function softDeleteInboundState(
  db: D1Database,
  userId: string,
  emailMessageId: string,
  read: boolean,
  starred: boolean,
  timestamp: string
) {
  return db.prepare(`
    INSERT INTO workspace_email_states (id, user_id, email_message_id, is_read, is_starred, deleted_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, email_message_id) DO UPDATE SET
      deleted_at = excluded.deleted_at, updated_at = excluded.updated_at
  `).bind(
    crypto.randomUUID(),
    userId,
    emailMessageId,
    read ? 1 : 0,
    starred ? 1 : 0,
    timestamp,
    timestamp,
    timestamp
  );
}
