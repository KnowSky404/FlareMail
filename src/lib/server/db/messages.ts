import type { MailboxMutationAction } from '$lib/domain/mail';
import { fromInboundMessageId, isInboundMessageId } from '$lib/domain/mail';
import type { WorkspaceCapabilities, WorkspaceInboundRow, WorkspaceMessageRow } from '$lib/server/workspace/shared';

export interface OwnedMailboxMutationRow {
  id: string;
  source: 'workspace' | 'inbound';
  folder: 'inbox' | 'sent';
  thread_key: string | null;
  is_read: number;
  is_starred: number;
  archived_at: string | null;
}

const placeholders = (values: string[]) => values.map(() => '?').join(', ');

function splitMailboxIds(messageIds: string[]) {
  return {
    workspaceIds: messageIds.filter((id) => !isInboundMessageId(id)),
    inboundIds: messageIds.filter(isInboundMessageId).map(fromInboundMessageId)
  };
}

export async function listOwnedMailboxMutationRows(
  db: D1Database,
  userId: string,
  messageIds: string[]
): Promise<OwnedMailboxMutationRow[]> {
  const { workspaceIds, inboundIds } = splitMailboxIds(messageIds);
  const rows: OwnedMailboxMutationRow[] = [];
  if (workspaceIds.length) {
    const result = await db.prepare(`
      SELECT id, 'workspace' AS source, folder, thread_key, is_read, is_starred, archived_at
      FROM workspace_messages
      WHERE user_id = ? AND folder IN ('inbox', 'sent') AND deleted_at IS NULL AND id IN (${placeholders(workspaceIds)})
    `).bind(userId, ...workspaceIds).all<OwnedMailboxMutationRow>();
    rows.push(...(result.results ?? []));
  }
  if (inboundIds.length) {
    const result = await db.prepare(`
      SELECT 'email:' || e.id AS id, 'inbound' AS source, 'inbox' AS folder, e.thread_key,
        COALESCE(s.is_read, 0) AS is_read, COALESCE(s.is_starred, 0) AS is_starred,
        s.archived_at
      FROM email_messages AS e
      LEFT JOIN workspace_email_states AS s
        ON s.user_id = ? AND s.email_message_id = e.id
      WHERE e.owner_user_id = ? AND s.deleted_at IS NULL AND e.id IN (${placeholders(inboundIds)})
    `).bind(userId, userId, ...inboundIds).all<OwnedMailboxMutationRow>();
    rows.push(...(result.results ?? []));
  }
  return rows;
}

export async function resolveOwnedMailboxThreadMessageIds(
  db: D1Database,
  userId: string,
  threadKeys: string[]
): Promise<string[]> {
  if (!threadKeys.length) return [];
  const ids: string[] = [];
  const threadPlaceholders = placeholders(threadKeys);
  const workspaceRows = await db.prepare(`
    SELECT id FROM workspace_messages
    WHERE user_id = ? AND folder = 'inbox' AND deleted_at IS NULL AND thread_key IN (${threadPlaceholders})
  `).bind(userId, ...threadKeys).all<{ id: string }>();
  ids.push(...(workspaceRows.results ?? []).map((row) => row.id));
  const inboundRows = await db.prepare(`
    SELECT 'email:' || e.id AS id
    FROM email_messages AS e
    LEFT JOIN workspace_email_states AS s
      ON s.user_id = ? AND s.email_message_id = e.id
    WHERE e.owner_user_id = ? AND s.deleted_at IS NULL AND e.thread_key IN (${threadPlaceholders})
  `).bind(userId, userId, ...threadKeys).all<{ id: string }>();
  ids.push(...(inboundRows.results ?? []).map((row) => row.id));
  return [...new Set(ids)];
}

function inboundMutationStatement(
  db: D1Database,
  userId: string,
  inboundId: string,
  action: MailboxMutationAction,
  timestamp: string
) {
  const readExpression = action === 'read' ? '1' : action === 'unread' ? '0' : 'COALESCE(s.is_read, 0)';
  const starredExpression = action === 'star' ? '1' : action === 'unstar' ? '0' : 'COALESCE(s.is_starred, 0)';
  const archiveExpression = action === 'archive'
    ? 'COALESCE(s.archived_at, ?)'
    : action === 'unarchive' ? 'NULL' : 's.archived_at';
  const bindings: unknown[] = [crypto.randomUUID(), userId];
  if (action === 'archive') bindings.push(timestamp);
  bindings.push(timestamp, timestamp, userId, userId, inboundId);
  return db.prepare(`
    INSERT INTO workspace_email_states (
      id, user_id, email_message_id, is_read, is_starred, archived_at, deleted_at, created_at, updated_at
    )
    SELECT ?, ?, e.id, ${readExpression}, ${starredExpression}, ${archiveExpression}, NULL, ?, ?
    FROM email_messages AS e
    LEFT JOIN workspace_email_states AS s
      ON s.user_id = ? AND s.email_message_id = e.id
    WHERE e.owner_user_id = ? AND e.id = ? AND s.deleted_at IS NULL
    ON CONFLICT(user_id, email_message_id) DO UPDATE SET
      is_read = excluded.is_read,
      is_starred = excluded.is_starred,
      archived_at = excluded.archived_at,
      deleted_at = NULL,
      updated_at = excluded.updated_at
  `).bind(...bindings);
}

export function buildMailboxMutationStatements(
  db: D1Database,
  userId: string,
  messageIds: string[],
  action: MailboxMutationAction,
  timestamp: string
): D1PreparedStatement[] {
  const { workspaceIds, inboundIds } = splitMailboxIds(messageIds);
  const statements: D1PreparedStatement[] = [];
  if (workspaceIds.length) {
    const archiveExpression = action === 'archive' ? 'COALESCE(archived_at, ?)' : action === 'unarchive' ? 'NULL' : 'archived_at';
    const setParts = [
      action === 'read' ? 'is_read = 1' : action === 'unread' ? 'is_read = 0' : '',
      action === 'star' ? 'is_starred = 1' : action === 'unstar' ? 'is_starred = 0' : '',
      action === 'archive' || action === 'unarchive' ? `archived_at = ${archiveExpression}` : '',
      'updated_at = ?'
    ].filter(Boolean);
    const bindings: unknown[] = [];
    if (action === 'archive') bindings.push(timestamp);
    bindings.push(timestamp, userId, ...workspaceIds);
    statements.push(db.prepare(`
      UPDATE workspace_messages
      SET ${setParts.join(', ')}
      WHERE user_id = ? AND folder IN ('inbox', 'sent') AND id IN (${placeholders(workspaceIds)})
    `).bind(...bindings));
  }
  statements.push(...inboundIds.map((inboundId) => inboundMutationStatement(db, userId, inboundId, action, timestamp)));
  return statements;
}

export async function listMessages(db: D1Database, userId: string) {
  return db.prepare(`
    SELECT id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at, labels_json, is_read, is_starred,
      message_id, in_reply_to, "references", thread_key, cc, to_json, cc_json, bcc_json, idempotency_key, archived_at, body_object_id, deleted_at
    FROM workspace_messages WHERE user_id = ? AND deleted_at IS NULL AND (folder <> 'inbox' OR archived_at IS NULL)
    ORDER BY sent_at DESC, created_at DESC
  `).bind(userId).all<WorkspaceMessageRow>();
}

export async function listInboundMessages(db: D1Database, userId: string, _loginEmail: string, _profileEmail: string, capabilities: WorkspaceCapabilities) {
  if (!capabilities.inboundStates) return { results: [] as WorkspaceInboundRow[] };
  return db.prepare(`
    SELECT e.id AS email_id, e."from", e."to", e.subject, e."timestamp", e.snippet,
      e.message_id, e.in_reply_to, e."references", e.thread_key, s.archived_at,
      COALESCE(s.is_read, 0) AS is_read, COALESCE(s.is_starred, 0) AS is_starred
    FROM email_messages AS e LEFT JOIN workspace_email_states AS s
      ON s.user_id = ? AND s.email_message_id = e.id
    WHERE e.owner_user_id = ? AND s.deleted_at IS NULL AND s.archived_at IS NULL
    ORDER BY e."timestamp" DESC, e.id DESC
  `).bind(userId, userId).all<WorkspaceInboundRow>();
}

export function insertMessage(db: D1Database, payload: ReturnType<typeof import('$lib/server/workspace/shared').serializeMessageForInsert>) {
  return db.prepare(`
    INSERT INTO workspace_messages (user_id, id, folder, from_name, from_email, to_name, to_email, to_json, subject, preview, body, sent_at, labels_json, is_read, is_starred,
      message_id, in_reply_to, "references", thread_key, cc, cc_json, bcc_json, idempotency_key, body_object_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(payload.userId, payload.id, payload.folder, payload.fromName, payload.fromEmail, payload.toName, payload.toEmail,
    payload.toJson, payload.subject, payload.preview, payload.body, payload.sentAt, payload.labelsJson, payload.isRead, payload.isStarred,
    payload.messageId, payload.inReplyTo, payload.references, payload.threadKey, payload.cc, payload.ccJson, payload.bccJson, payload.idempotencyKey, payload.bodyObjectId,
    payload.createdAt, payload.updatedAt);
}

export async function findMessageByIdempotencyKey(db: D1Database, userId: string, idempotencyKey: string) {
  return db.prepare(`
    SELECT id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at,
      labels_json, is_read, is_starred, message_id, in_reply_to, "references", thread_key, cc, to_json, cc_json, bcc_json, idempotency_key, archived_at, body_object_id, deleted_at
    FROM workspace_messages WHERE user_id = ? AND idempotency_key = ?
  `).bind(userId, idempotencyKey).first<WorkspaceMessageRow>();
}

export async function findOwnedWorkspaceMessage(db: D1Database, userId: string, messageId: string) {
  return db.prepare(`
    SELECT id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at,
      labels_json, is_read, is_starred, message_id, in_reply_to, "references", thread_key, cc, to_json, cc_json, bcc_json, idempotency_key, archived_at, body_object_id, deleted_at
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
