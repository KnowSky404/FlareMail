import type { DeliveryStatus, MailFolder, MailboxFilter, MailboxSection, WorkspaceMetrics } from '$lib/domain/mail';
import type {
  WorkspaceDraftRow,
  WorkspaceInboundRow,
  WorkspaceMessageRow,
  WorkspaceOutboundStatusRow
} from '$lib/server/workspace/shared';

export interface MailboxRepositoryQuery {
  folder: MailFolder;
  section?: MailboxSection;
  timestamp?: string;
  cursorId?: string;
  limit: number;
  query: string;
  filter: MailboxFilter;
  deliveryStatus: DeliveryStatus | null;
}

export interface WorkspaceMessagePageRow extends WorkspaceMessageRow {
  archived_at: string | null;
  delivery_status: WorkspaceOutboundStatusRow['status'] | null;
  delivery_attempts: number | null;
  delivery_delivered_at: string | null;
  delivery_last_error: string | null;
  delivery_provider_message_id: string | null;
  delivery_provider: string | null;
  delivery_result_kind: WorkspaceOutboundStatusRow['result_kind'] | null;
  delivery_remote_status: number | null;
  delivery_response_preview: string | null;
  delivery_last_event: WorkspaceOutboundStatusRow['last_event'] | null;
  delivery_last_event_at: string | null;
  delivery_idempotency_key: string | null;
  delivery_attempt_started_at: string | null;
}

const searchPattern = (query: string) => `%${query.toLocaleLowerCase()}%`;

function flagPredicate(filter: MailboxFilter, readColumn: string, starredColumn: string) {
  if (filter === 'unread') return `${readColumn} = 0`;
  if (filter === 'starred') return `${starredColumn} = 1`;
  return '1 = 1';
}

export async function listWorkspaceMessagePage(
  db: D1Database,
  userId: string,
  input: MailboxRepositoryQuery
) {
  const conditions = [
    'm.user_id = ?',
    'm.folder = ?',
    input.folder === 'inbox' && input.section === 'archive' ? 'm.archived_at IS NOT NULL' :
      input.folder === 'inbox' ? 'm.archived_at IS NULL' : '1 = 1',
    flagPredicate(input.filter, 'm.is_read', 'm.is_starred')
  ];
  const bindings: unknown[] = [userId, input.folder];
  if (input.query) {
    conditions.push(`(
      lower(m.subject) LIKE ? OR lower(m.preview) LIKE ? OR lower(m.body) LIKE ? OR
      lower(m.from_name) LIKE ? OR lower(m.from_email) LIKE ? OR
      lower(m.to_name) LIKE ? OR lower(m.to_email) LIKE ?
    )`);
    bindings.push(...Array(7).fill(searchPattern(input.query)));
  }
  if (input.timestamp && input.cursorId) {
    conditions.push('(m.sent_at < ? OR (m.sent_at = ? AND m.id < ?))');
    bindings.push(input.timestamp, input.timestamp, input.cursorId);
  }
  if (input.deliveryStatus) {
    conditions.push('ds.status = ?');
    bindings.push(input.deliveryStatus);
  }
  bindings.push(input.limit);

  return db.prepare(`
    SELECT
      m.id, m.folder, m.from_name, m.from_email, m.to_name, m.to_email,
      m.subject, m.preview, m.body, m.sent_at, m.labels_json, m.is_read, m.is_starred, m.archived_at,
      m.message_id, m.in_reply_to, m."references", m.thread_key, m.cc, m.idempotency_key,
      ds.status AS delivery_status,
      ds.attempts AS delivery_attempts,
      ds.delivered_at AS delivery_delivered_at,
      ds.last_error AS delivery_last_error,
      ds.provider_message_id AS delivery_provider_message_id,
      ds.provider AS delivery_provider,
      r.result_kind AS delivery_result_kind,
      r.remote_status AS delivery_remote_status,
      r.response_preview AS delivery_response_preview,
      r.last_event AS delivery_last_event,
      r.last_event_at AS delivery_last_event_at,
      ds.idempotency_key AS delivery_idempotency_key,
      (SELECT MAX(a.started_at) FROM workspace_delivery_attempts AS a WHERE a.message_id = m.id) AS delivery_attempt_started_at
    FROM workspace_messages AS m
    LEFT JOIN workspace_delivery_statuses AS ds
      ON ds.user_id = m.user_id AND ds.message_id = m.id
    LEFT JOIN workspace_outbound_receipts AS r
      ON r.user_id = m.user_id AND r.message_id = m.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.sent_at DESC, m.id DESC
    LIMIT ?
  `).bind(...bindings).all<WorkspaceMessagePageRow>();
}

export async function listInboundMessagePage(
  db: D1Database,
  userId: string,
  input: MailboxRepositoryQuery
) {
  const conditions = [
    'e.owner_user_id = ?',
    's.deleted_at IS NULL',
    input.section === 'archive' ? 's.archived_at IS NOT NULL' : 'COALESCE(s.archived_at, NULL) IS NULL',
    flagPredicate(input.filter, 'COALESCE(s.is_read, 0)', 'COALESCE(s.is_starred, 0)')
  ];
  const bindings: unknown[] = [userId];
  if (input.query) {
    conditions.push(`(
      lower(e.subject) LIKE ? OR lower(e.snippet) LIKE ? OR
      lower(e."from") LIKE ? OR lower(e."to") LIKE ?
    )`);
    bindings.push(...Array(5).fill(searchPattern(input.query)));
  }
  if (input.timestamp && input.cursorId) {
    conditions.push(`(e."timestamp" < ? OR (e."timestamp" = ? AND ('email:' || e.id) < ?))`);
    bindings.push(input.timestamp, input.timestamp, input.cursorId);
  }
  bindings.push(input.limit);

  return db.prepare(`
    SELECT e.id AS email_id, e."from", e."to", e.subject, e."timestamp", e.snippet,
      e.message_id, e.in_reply_to, e."references", e.thread_key, s.archived_at,
      COALESCE(s.is_read, 0) AS is_read, COALESCE(s.is_starred, 0) AS is_starred
    FROM email_messages AS e
    LEFT JOIN workspace_email_states AS s
      ON s.user_id = ? AND s.email_message_id = e.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY e."timestamp" DESC, ('email:' || e.id) DESC
    LIMIT ?
  `).bind(userId, ...bindings).all<WorkspaceInboundRow>();
}

export async function listDraftPage(
  db: D1Database,
  userId: string,
  input: MailboxRepositoryQuery
) {
  const conditions = [
    'd.user_id = ?',
    input.filter === 'starred' ? 'd.is_starred = 1' : '1 = 1'
  ];
  const bindings: unknown[] = [userId];
  if (input.filter === 'unread') conditions.push('1 = 0');
  if (input.query) {
    conditions.push('(lower(d.subject) LIKE ? OR lower(d.body) LIKE ? OR lower(d.to_email) LIKE ? OR lower(d.cc) LIKE ?)');
    bindings.push(...Array(4).fill(searchPattern(input.query)));
  }
  if (input.timestamp && input.cursorId) {
    conditions.push('(d.updated_at < ? OR (d.updated_at = ? AND d.id < ?))');
    bindings.push(input.timestamp, input.timestamp, input.cursorId);
  }
  bindings.push(input.limit);

  return db.prepare(`
    SELECT d.id, d.to_email, d.cc, d.subject, d.body, d.is_starred, d.created_at, d.updated_at,
      d.message_id, d.in_reply_to, d."references", d.thread_key, d.idempotency_key
    FROM workspace_drafts AS d
    WHERE ${conditions.join(' AND ')}
    ORDER BY d.updated_at DESC, d.id DESC
    LIMIT ?
  `).bind(...bindings).all<WorkspaceDraftRow>();
}

export async function getMailboxMetrics(db: D1Database, userId: string): Promise<WorkspaceMetrics> {
  const row = await db.prepare(`
    SELECT
      (
        SELECT COUNT(*) FROM workspace_messages
        WHERE user_id = ? AND folder = 'inbox' AND archived_at IS NULL
      ) + (
        SELECT COUNT(*) FROM email_messages AS e
        LEFT JOIN workspace_email_states AS s ON s.user_id = ? AND s.email_message_id = e.id
        WHERE e.owner_user_id = ? AND s.deleted_at IS NULL AND s.archived_at IS NULL
      ) AS inbox_count,
      (
        SELECT COUNT(*) FROM workspace_messages
        WHERE user_id = ? AND folder = 'sent'
      ) AS sent_count,
      (
        SELECT COUNT(*) FROM workspace_drafts WHERE user_id = ?
      ) AS drafts_count,
      (
        SELECT COUNT(*) FROM workspace_messages
        WHERE user_id = ? AND folder = 'inbox' AND archived_at IS NULL AND is_read = 0
      ) + (
        SELECT COUNT(*) FROM email_messages AS e
        LEFT JOIN workspace_email_states AS s ON s.user_id = ? AND s.email_message_id = e.id
        WHERE e.owner_user_id = ? AND s.deleted_at IS NULL AND s.archived_at IS NULL AND COALESCE(s.is_read, 0) = 0
      ) AS unread_count,
      (
        SELECT COUNT(*) FROM workspace_messages WHERE user_id = ? AND is_starred = 1
      ) + (
        SELECT COUNT(*) FROM workspace_drafts WHERE user_id = ? AND is_starred = 1
      ) + (
        SELECT COUNT(*) FROM email_messages AS e
        JOIN workspace_email_states AS s ON s.user_id = ? AND s.email_message_id = e.id
        WHERE e.owner_user_id = ? AND s.deleted_at IS NULL AND s.is_starred = 1
      ) AS starred_count
  `).bind(
    userId, userId, userId, userId, userId,
    userId, userId, userId, userId, userId,
    userId, userId
  ).first<{
    inbox_count: number;
    sent_count: number;
    drafts_count: number;
    unread_count: number;
    starred_count: number;
  }>();

  return {
    inboxCount: Number(row?.inbox_count ?? 0),
    sentCount: Number(row?.sent_count ?? 0),
    draftsCount: Number(row?.drafts_count ?? 0),
    unreadCount: Number(row?.unread_count ?? 0),
    starredCount: Number(row?.starred_count ?? 0)
  };
}

export function mapPageDeliveryStatus(row: WorkspaceMessagePageRow): WorkspaceOutboundStatusRow | undefined {
  if (!row.delivery_status) return undefined;
  return {
    message_id: row.id,
    status: row.delivery_status,
    attempts: row.delivery_attempts ?? 0,
    delivered_at: row.delivery_delivered_at,
    last_error: row.delivery_last_error ?? '',
    provider_message_id: row.delivery_provider_message_id,
    provider: row.delivery_provider,
    result_kind: row.delivery_result_kind,
    remote_status: row.delivery_remote_status,
    response_preview: row.delivery_response_preview ?? '',
    last_event: row.delivery_last_event,
    last_event_at: row.delivery_last_event_at,
    idempotency_key: row.delivery_idempotency_key,
    attempt_started_at: row.delivery_attempt_started_at
  };
}
