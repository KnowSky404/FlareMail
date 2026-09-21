import type { DeliveryStatus, MailFolder, MailboxFilter, MailboxIdentityFilter, MailboxSection, MailSearchQuery, WorkspaceMetrics } from '$lib/domain/mail';
import { buildFtsSearchPlan } from '$lib/server/search/fts';
import type {
  WorkspaceDraftRow,
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
  search: MailSearchQuery | null;
  filter: MailboxFilter;
  identityFilter?: MailboxIdentityFilter | null;
  deliveryStatus: DeliveryStatus | null;
  /** Optional thread anchors used by a bounded bulk-operation preview/resolution. */
  threadKeys?: string[];
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

function flagPredicate(filter: MailboxFilter, readColumn: string, starredColumn: string) {
  if (filter === 'unread') return `${readColumn} = 0`;
  if (filter === 'starred') return `${starredColumn} = 1`;
  return '1 = 1';
}

function identityPredicate(alias: string, addressColumn: string, ownerColumn = `${alias}.user_id`) {
  const addressExpression = addressColumn.startsWith('CASE WHEN') ? addressColumn : `${alias}.${addressColumn}`;
  return `(
    (SELECT kind FROM identity_scope) IS NULL
    OR ((SELECT kind FROM identity_scope) = 'address' AND ${addressExpression} = (SELECT id FROM identity_scope))
    OR ((SELECT kind FROM identity_scope) = 'domain' AND EXISTS (
      SELECT 1 FROM mail_addresses AS identity_address
      WHERE identity_address.id = ${addressExpression}
        AND identity_address.owner_user_id = ${ownerColumn}
        AND identity_address.domain_id = (SELECT id FROM identity_scope)
    ))
  )`;
}

function inboundIdentityPredicate(alias: string) {
  return `(
    (SELECT kind FROM identity_scope) IS NULL
    OR ((SELECT kind FROM identity_scope) = 'address' AND ${alias}.mail_address_id = (SELECT id FROM identity_scope))
    OR ((SELECT kind FROM identity_scope) = 'domain' AND ${alias}.mail_domain_id = (SELECT id FROM identity_scope))
  )`;
}

export async function listWorkspaceMessagePage(
  db: D1Database,
  userId: string,
  input: MailboxRepositoryQuery
) {
  const searchPlan = input.search ? buildFtsSearchPlan(input.search) : null;
  const wantsTrash = input.search?.filters.is.includes('trash') ?? false;
  const wantsArchive = input.search?.filters.is.includes('archived') ?? false;
  const conditions = [
    'm.user_id = ?',
    'm.folder = ?',
    wantsTrash ? 'm.deleted_at IS NOT NULL' : 'm.deleted_at IS NULL',
    wantsArchive ? 'm.archived_at IS NOT NULL' :
      wantsTrash ? '1 = 1' :
      input.folder === 'inbox' && input.section === 'archive' ? 'm.archived_at IS NOT NULL' :
      input.folder === 'inbox' ? 'm.archived_at IS NULL' : '1 = 1',
    flagPredicate(input.filter, 'm.is_read', 'm.is_starred'),
    identityPredicate('m', input.folder === 'sent' ? 'sender_address_id' : 'recipient_address_id')
  ];
  const bindings: unknown[] = [userId, input.folder];
  if (searchPlan?.expression) {
    conditions.push('workspace_search_fts MATCH ?');
    bindings.push(searchPlan.expression);
  }
  if (input.search) {
    for (const value of input.search.filters.is) {
      if (value === 'unread') conditions.push('m.is_read = 0');
      if (value === 'starred') conditions.push('m.is_starred = 1');
      if (value === 'archived') conditions.push("m.folder = 'inbox'");
    }
    if (input.search.filters.hasAttachment) {
      conditions.push('EXISTS (SELECT 1 FROM workspace_attachments AS search_attachment WHERE search_attachment.user_id = m.user_id AND search_attachment.message_id = m.id)');
    }
    for (const value of input.search.filters.after) {
      conditions.push('m.sent_at >= ?');
      bindings.push(`${value}T00:00:00.000Z`);
    }
    for (const value of input.search.filters.before) {
      conditions.push('m.sent_at < ?');
      bindings.push(`${value}T00:00:00.000Z`);
    }
    if (input.search.filters.status.length) {
      conditions.push(`ds.status IN (${input.search.filters.status.map(() => '?').join(', ')})`);
      bindings.push(...input.search.filters.status);
    }
  }
  if (input.timestamp && input.cursorId) {
    conditions.push('(m.sent_at < ? OR (m.sent_at = ? AND m.id < ?))');
    bindings.push(input.timestamp, input.timestamp, input.cursorId);
  }
  if (input.deliveryStatus) {
    conditions.push('ds.status = ?');
    bindings.push(input.deliveryStatus);
  }
  if (input.threadKeys?.length) {
    conditions.push(`m.thread_key IN (${input.threadKeys.map(() => '?').join(', ')})`);
    bindings.push(...input.threadKeys);
  }
  bindings.push(input.limit);

  const searchJoins = input.search ? `
    JOIN workspace_search_documents AS search_document
      ON search_document.user_id = m.user_id AND search_document.entity_kind = 'message' AND search_document.entity_id = m.id
    ${searchPlan?.expression ? 'JOIN workspace_search_fts ON workspace_search_fts.rowid = search_document.id' : ''}` : '';
  const searchSnippet = input.search
    ? searchPlan?.expression
      ? `snippet(workspace_search_fts, -1, char(57344), char(57345), ' … ', 16)`
      : `substr(search_document.subject_text, 1, 160)`
    : `NULL`;

  const pageSelect = `
    SELECT
      m.id, m.folder, m.from_name, m.from_email, m.to_name, m.to_email,
      m.subject, m.preview, '' AS body, m.sent_at, m.labels_json, m.is_read, m.is_starred, m.archived_at,
      m.message_id, m.in_reply_to, m."references", m.thread_key, m.cc, m.to_json, m.cc_json, m.bcc_json, m.idempotency_key, m.body_object_id, m.deleted_at,
      m.sender_address_id, m.recipient_address_id, m.reply_to_json,
      ${searchSnippet} AS search_snippet,
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
    ${searchJoins}
    LEFT JOIN workspace_delivery_statuses AS ds
      ON ds.user_id = m.user_id AND ds.message_id = m.id
    LEFT JOIN workspace_outbound_receipts AS r
      ON r.user_id = m.user_id AND r.message_id = m.id
    WHERE ${conditions.join(' AND ')}`;
  const pageSql = `WITH identity_scope AS (SELECT ? AS kind, ? AS id) ` + (input.search
    ? `SELECT search_rows.*, COUNT(*) OVER() AS search_total FROM (${pageSelect}) AS search_rows
       ORDER BY search_rows.sent_at DESC, search_rows.id DESC LIMIT ?`
    : `${pageSelect} ORDER BY m.sent_at DESC, m.id DESC LIMIT ?`);
  return db.prepare(pageSql).bind(input.identityFilter?.kind ?? null, input.identityFilter?.id ?? null, ...bindings).all<WorkspaceMessagePageRow>();
}

export async function listDraftPage(
  db: D1Database,
  userId: string,
  input: MailboxRepositoryQuery
) {
  const searchPlan = input.search ? buildFtsSearchPlan(input.search) : null;
  const wantsTrash = input.search?.filters.is.includes('trash') ?? false;
  const conditions = [
    'd.user_id = ?',
    wantsTrash ? 'd.deleted_at IS NOT NULL' : 'd.deleted_at IS NULL',
    input.filter === 'starred' ? 'd.is_starred = 1' : '1 = 1',
    identityPredicate('d', 'sender_address_id')
  ];
  const bindings: unknown[] = [userId];
  if (input.filter === 'unread') conditions.push('1 = 0');
  if (searchPlan?.expression) {
    conditions.push('workspace_search_fts MATCH ?');
    bindings.push(searchPlan.expression);
  }
  if (input.search) {
    for (const value of input.search.filters.is) {
      if (value === 'unread' || value === 'archived') conditions.push('1 = 0');
      if (value === 'starred') conditions.push('d.is_starred = 1');
    }
    if (input.search.filters.hasAttachment) {
      conditions.push('EXISTS (SELECT 1 FROM workspace_attachments AS search_attachment WHERE search_attachment.user_id = d.user_id AND search_attachment.message_id = d.id)');
    }
    for (const value of input.search.filters.after) {
      conditions.push('d.updated_at >= ?');
      bindings.push(`${value}T00:00:00.000Z`);
    }
    for (const value of input.search.filters.before) {
      conditions.push('d.updated_at < ?');
      bindings.push(`${value}T00:00:00.000Z`);
    }
    if (input.search.filters.status.length && !input.search.filters.status.includes('draft')) conditions.push('1 = 0');
  }
  if (input.timestamp && input.cursorId) {
    conditions.push('(d.updated_at < ? OR (d.updated_at = ? AND d.id < ?))');
    bindings.push(input.timestamp, input.timestamp, input.cursorId);
  }
  bindings.push(input.limit);

  const searchJoins = input.search ? `
    JOIN workspace_search_documents AS search_document
      ON search_document.user_id = d.user_id AND search_document.entity_kind = 'draft' AND search_document.entity_id = d.id
    ${searchPlan?.expression ? 'JOIN workspace_search_fts ON workspace_search_fts.rowid = search_document.id' : ''}` : '';
  const searchSnippet = input.search
    ? searchPlan?.expression
      ? `snippet(workspace_search_fts, -1, char(57344), char(57345), ' … ', 16)`
      : `substr(search_document.subject_text, 1, 160)`
    : `NULL`;

  const pageSelect = `
    SELECT d.id, d.to_email, d.cc, d.to_json, d.cc_json, d.bcc_json, d.subject, '' AS body, d.is_starred, d.created_at, d.updated_at,
      d.message_id, d.in_reply_to, d."references", d.thread_key, d.idempotency_key, d.body_object_id, d.deleted_at,
      d.sender_address_id, d.from_name, d.from_email, d.reply_to_json,
      ${searchSnippet} AS search_snippet
    FROM workspace_drafts AS d
    ${searchJoins}
    WHERE ${conditions.join(' AND ')}`;
  const pageSql = `WITH identity_scope AS (SELECT ? AS kind, ? AS id) ` + (input.search
    ? `SELECT search_rows.*, COUNT(*) OVER() AS search_total FROM (${pageSelect}) AS search_rows
       ORDER BY search_rows.updated_at DESC, search_rows.id DESC LIMIT ?`
    : `${pageSelect} ORDER BY d.updated_at DESC, d.id DESC LIMIT ?`);
  return db.prepare(pageSql).bind(input.identityFilter?.kind ?? null, input.identityFilter?.id ?? null, ...bindings).all<WorkspaceDraftRow>();
}

export async function getMailboxMetrics(
  db: D1Database,
  userId: string,
  identityFilter: MailboxIdentityFilter | null = null
): Promise<WorkspaceMetrics> {
  const row = await db.prepare(`
    WITH identity_scope AS (SELECT ? AS kind, ? AS id), owner_scope AS (SELECT ? AS id)
    SELECT
      (
        SELECT COUNT(*) FROM workspace_messages AS m
        WHERE m.user_id = (SELECT id FROM owner_scope) AND m.folder = 'inbox' AND m.deleted_at IS NULL AND m.archived_at IS NULL
          AND ${identityPredicate('m', 'recipient_address_id')}
      ) + (
        SELECT COUNT(*) FROM email_messages AS e
        LEFT JOIN workspace_email_states AS s ON s.user_id = (SELECT id FROM owner_scope) AND s.email_message_id = e.id
        WHERE e.owner_user_id = (SELECT id FROM owner_scope) AND s.deleted_at IS NULL AND s.archived_at IS NULL
          AND ${inboundIdentityPredicate('e')}
      ) AS inbox_count,
      (
        SELECT COUNT(*) FROM workspace_messages AS m
        WHERE m.user_id = (SELECT id FROM owner_scope) AND m.folder = 'sent' AND m.deleted_at IS NULL
          AND ${identityPredicate('m', 'sender_address_id')}
      ) AS sent_count,
      (
        SELECT COUNT(*) FROM workspace_messages AS m
        WHERE m.user_id = (SELECT id FROM owner_scope) AND m.folder = 'inbox' AND m.deleted_at IS NULL AND m.archived_at IS NOT NULL
          AND ${identityPredicate('m', 'recipient_address_id')}
      ) + (
        SELECT COUNT(*) FROM email_messages AS e
        JOIN workspace_email_states AS s ON s.user_id = (SELECT id FROM owner_scope) AND s.email_message_id = e.id
        WHERE e.owner_user_id = (SELECT id FROM owner_scope) AND s.deleted_at IS NULL AND s.archived_at IS NOT NULL
          AND ${inboundIdentityPredicate('e')}
      ) AS archive_count,
      (
        SELECT COUNT(*) FROM workspace_drafts AS d WHERE d.user_id = (SELECT id FROM owner_scope) AND d.deleted_at IS NULL
          AND ${identityPredicate('d', 'sender_address_id')}
      ) AS drafts_count,
      (
        SELECT COUNT(*) FROM workspace_messages AS m
        WHERE m.user_id = (SELECT id FROM owner_scope) AND m.deleted_at IS NOT NULL
          AND ${identityPredicate('m', "CASE WHEN m.folder = 'sent' THEN m.sender_address_id ELSE m.recipient_address_id END")}
      ) + (
        SELECT COUNT(*) FROM workspace_drafts AS d WHERE d.user_id = (SELECT id FROM owner_scope) AND d.deleted_at IS NOT NULL
          AND ${identityPredicate('d', 'sender_address_id')}
      ) + (
        SELECT COUNT(*) FROM email_messages AS e
        JOIN workspace_email_states AS s ON s.user_id = (SELECT id FROM owner_scope) AND s.email_message_id = e.id
        WHERE e.owner_user_id = (SELECT id FROM owner_scope) AND s.deleted_at IS NOT NULL
          AND ${inboundIdentityPredicate('e')}
      ) AS trash_count,
      (
        SELECT COUNT(*) FROM workspace_messages AS m
        WHERE m.user_id = (SELECT id FROM owner_scope) AND m.folder = 'inbox' AND m.deleted_at IS NULL AND m.archived_at IS NULL AND m.is_read = 0
          AND ${identityPredicate('m', 'recipient_address_id')}
      ) + (
        SELECT COUNT(*) FROM email_messages AS e
        LEFT JOIN workspace_email_states AS s ON s.user_id = (SELECT id FROM owner_scope) AND s.email_message_id = e.id
        WHERE e.owner_user_id = (SELECT id FROM owner_scope) AND s.deleted_at IS NULL AND s.archived_at IS NULL AND COALESCE(s.is_read, 0) = 0
          AND ${inboundIdentityPredicate('e')}
      ) AS unread_count,
      (
        SELECT COUNT(*) FROM workspace_messages AS m WHERE m.user_id = (SELECT id FROM owner_scope) AND m.deleted_at IS NULL AND m.is_starred = 1
          AND ${identityPredicate('m', "CASE WHEN m.folder = 'sent' THEN m.sender_address_id ELSE m.recipient_address_id END")}
      ) + (
        SELECT COUNT(*) FROM workspace_drafts AS d WHERE d.user_id = (SELECT id FROM owner_scope) AND d.deleted_at IS NULL AND d.is_starred = 1
          AND ${identityPredicate('d', 'sender_address_id')}
      ) + (
        SELECT COUNT(*) FROM email_messages AS e
        JOIN workspace_email_states AS s ON s.user_id = (SELECT id FROM owner_scope) AND s.email_message_id = e.id
        WHERE e.owner_user_id = (SELECT id FROM owner_scope) AND s.deleted_at IS NULL AND s.is_starred = 1
          AND ${inboundIdentityPredicate('e')}
      ) AS starred_count,
      (SELECT COUNT(*) FROM workspace_delivery_statuses AS ds
       LEFT JOIN workspace_messages AS m ON m.user_id = ds.user_id AND m.id = ds.message_id
       WHERE ds.user_id = (SELECT id FROM owner_scope) AND ds.status IN ('queued', 'submitting')
         AND ${identityPredicate('m', 'sender_address_id')}) AS queued_count,
      (SELECT COUNT(*) FROM workspace_delivery_statuses AS ds
       LEFT JOIN workspace_messages AS m ON m.user_id = ds.user_id AND m.id = ds.message_id
       WHERE ds.user_id = (SELECT id FROM owner_scope) AND ds.status = 'delayed'
         AND ${identityPredicate('m', 'sender_address_id')}) AS delayed_count,
      (SELECT COUNT(*) FROM workspace_delivery_statuses AS ds
       LEFT JOIN workspace_messages AS m ON m.user_id = ds.user_id AND m.id = ds.message_id
       WHERE ds.user_id = (SELECT id FROM owner_scope) AND ds.status IN ('failed', 'suppressed')
         AND ${identityPredicate('m', 'sender_address_id')}) AS failed_count,
      (SELECT COUNT(*) FROM workspace_delivery_statuses AS ds
       LEFT JOIN workspace_messages AS m ON m.user_id = ds.user_id AND m.id = ds.message_id
       WHERE ds.user_id = (SELECT id FROM owner_scope) AND ds.status = 'bounced'
         AND ${identityPredicate('m', 'sender_address_id')}) AS bounced_count,
      (SELECT COUNT(*) FROM workspace_delivery_statuses AS ds
       LEFT JOIN workspace_messages AS m ON m.user_id = ds.user_id AND m.id = ds.message_id
       WHERE ds.user_id = (SELECT id FROM owner_scope) AND ds.status = 'complained'
         AND ${identityPredicate('m', 'sender_address_id')}) AS complained_count,
      (SELECT COUNT(*) FROM workspace_delivery_statuses AS ds
       LEFT JOIN workspace_messages AS m ON m.user_id = ds.user_id AND m.id = ds.message_id
       WHERE ds.user_id = (SELECT id FROM owner_scope) AND ds.status = 'submitting'
         AND datetime(COALESCE(ds.last_event_at, ds.updated_at, ds.created_at)) <= datetime('now', '-15 minutes')
         AND ${identityPredicate('m', 'sender_address_id')}) AS stale_delivery_count
  `).bind(
    identityFilter?.kind ?? null,
    identityFilter?.id ?? null,
    userId
  ).first<{
    inbox_count: number;
    sent_count: number;
    archive_count: number;
    drafts_count: number;
    trash_count: number;
    unread_count: number;
    starred_count: number;
    queued_count: number;
    delayed_count: number;
    failed_count: number;
    bounced_count: number;
    complained_count: number;
    stale_delivery_count: number;
  }>();

  return {
    inboxCount: Number(row?.inbox_count ?? 0),
    sentCount: Number(row?.sent_count ?? 0),
    archiveCount: Number(row?.archive_count ?? 0),
    draftsCount: Number(row?.drafts_count ?? 0),
    trashCount: Number(row?.trash_count ?? 0),
    unreadCount: Number(row?.unread_count ?? 0),
    starredCount: Number(row?.starred_count ?? 0),
    queuedCount: Number(row?.queued_count ?? 0),
    delayedCount: Number(row?.delayed_count ?? 0),
    failedCount: Number(row?.failed_count ?? 0),
    bouncedCount: Number(row?.bounced_count ?? 0),
    complainedCount: Number(row?.complained_count ?? 0),
    staleDeliveryCount: Number(row?.stale_delivery_count ?? 0)
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
