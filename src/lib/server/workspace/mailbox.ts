import type { CloudflareEnv } from '$lib/server/cloudflare';
import { ApiError } from '$lib/server/http/api';
import { hasWorkspaceCoreTables } from '$lib/server/db/capabilities';
import { buildFtsSearchPlan } from '$lib/server/search/fts';
import {
  getMailboxMetrics,
  listDraftPage,
  listWorkspaceMessagePage,
  mapPageDeliveryStatus
} from '$lib/server/db/mailbox';
import {
  buildMailboxMutationStatements,
  listOwnedMailboxMutationRows,
  resolveOwnedMailboxThreadMessageIds
} from '$lib/server/db/messages';
import { findSessionJoin, findSessionJoinByTokenHash } from '$lib/server/db/sessions';
import {
  mapDraftRow,
  mapInboundRow,
  mapUserRowToProfile,
  mapWorkspaceMessageRow,
  serializeWorkspace,
  sortMessages,
  type WorkspaceInboundRow,
  type WorkspaceContext,
  type WorkspaceSession
} from '$lib/server/workspace/shared';
import { encodeMailboxCursor, parseMailboxQuery, type MailboxQuery } from '$lib/server/workspace/mailbox-query';
import type {
  DeliveryStatus,
  MailFolder,
  MailboxFilter,
  MailboxMessageSummary,
  MailboxMovement,
  MailboxMutationAction,
  MailboxMutationResult,
  MailboxPage,
  MailboxSection,
  MailboxState,
  MailSearchQuery,
  WorkspaceMetrics,
  WorkspaceSnapshot
} from '$lib/domain/mail';
import { parseMailSearchQuery } from '$lib/domain/mail';

export function parseArchiveMailboxQuery(params: URLSearchParams): MailboxQuery {
  const normalized = new URLSearchParams(params);
  normalized.set('folder', 'inbox');
  normalized.set('section', 'archive');
  return parseMailboxQuery(normalized);
}

export { serializeWorkspace };

export interface WorkspaceSnapshotOptions {
  activeFolder?: MailboxSection;
  limit?: number;
  query?: string;
  filter?: MailboxFilter;
  deliveryStatus?: DeliveryStatus | null;
}

const maxMailboxMutationIds = 100;

export interface WorkspaceMailboxMutationInput {
  action: MailboxMutationAction;
  messageIds: string[];
  threadKeys?: string[];
}

export async function mutateWorkspaceMailbox(
  env: CloudflareEnv,
  workspace: WorkspaceContext,
  input: WorkspaceMailboxMutationInput
): Promise<MailboxMutationResult> {
  const directIds = [...new Set(input.messageIds.map((id) => id.trim()).filter(Boolean))];
  const threadKeys = [...new Set((input.threadKeys ?? []).map((key) => key.trim()).filter(Boolean))];
  const resolvedIds = threadKeys.length
    ? await resolveOwnedMailboxThreadMessageIds(env.DB, workspace.userId, threadKeys, input.action === 'trash')
    : [];
  const messageIds = [...new Set([...directIds, ...resolvedIds])];
  if (messageIds.length === 0) throw new ApiError(400, 'MAILBOX_SELECTION_EMPTY', '请选择至少一封邮件。');
  if (messageIds.length > maxMailboxMutationIds) {
    throw new ApiError(400, 'MAILBOX_SELECTION_TOO_LARGE', `一次最多操作 ${maxMailboxMutationIds} 封邮件。`);
  }

  const rows = await listOwnedMailboxMutationRows(env.DB, workspace.userId, messageIds);
  const owned = new Map(rows.map((row) => [row.id, row]));
  if (rows.length !== messageIds.length || messageIds.some((id) => !owned.has(id))) {
    throw new ApiError(404, 'MAILBOX_MESSAGE_NOT_FOUND', '所选邮件不存在或不属于当前账号。');
  }
  if ((input.action === 'archive' || input.action === 'unarchive') && rows.some((row) => row.folder !== 'inbox')) {
    throw new ApiError(400, 'MAILBOX_ACTION_INVALID', '只有收件箱邮件支持归档操作。');
  }

  const timestamp = new Date().toISOString();
  const statements = buildMailboxMutationStatements(env.DB, workspace.userId, messageIds, input.action, timestamp);
  await env.DB.batch(statements);
  const summaries: MailboxMessageSummary[] = rows.map((row) => ({
    id: row.id,
    folder: row.folder,
    source: row.source,
    threadKey: row.thread_key,
    read: input.action === 'read' ? true : input.action === 'unread' ? false : Boolean(row.is_read),
    starred: input.action === 'star' ? true : input.action === 'unstar' ? false : Boolean(row.is_starred),
    archivedAt: input.action === 'archive' ? row.archived_at ?? timestamp : input.action === 'unarchive' ? null : row.archived_at
  }));
  const movement: MailboxMovement[] = [];
  for (const row of rows) {
    if (input.action === 'archive' && !row.archived_at) movement.push({ id: row.id, from: 'inbox', to: 'archive' });
    if (input.action === 'unarchive' && row.archived_at) movement.push({ id: row.id, from: 'archive', to: 'inbox' });
  }
  return {
    summaries,
    metrics: await getMailboxMetrics(env.DB, workspace.userId),
    movement
  };
}

async function loadSessionRow(
  env: CloudflareEnv,
  sessionRow: NonNullable<Awaited<ReturnType<typeof findSessionJoin>>>
): Promise<WorkspaceSession> {
  const context = mapSessionRow(sessionRow);
  const snapshot = await loadWorkspaceSnapshot(env, context);
  return {
    ...context,
    mailbox: snapshot.workspace.mailbox
  };
}

function mapSessionRow(
  sessionRow: NonNullable<Awaited<ReturnType<typeof findSessionJoin>>>
): WorkspaceContext {
  return {
    id: sessionRow.session_id,
    userId: sessionRow.id,
    profile: mapUserRowToProfile(sessionRow),
    incomingSequence: sessionRow.incoming_sequence,
    createdAt: sessionRow.created_at,
    updatedAt: sessionRow.updated_at,
    storage: 'd1'
  };
}

export async function loadD1WorkspaceContext(env: CloudflareEnv, sessionId: string): Promise<WorkspaceContext | null> {
  const sessionRow = await findSessionJoin(env.DB, sessionId);
  return sessionRow ? mapSessionRow(sessionRow) : null;
}

export async function loadD1WorkspaceContextByTokenHash(env: CloudflareEnv, tokenHash: string): Promise<WorkspaceContext | null> {
  const sessionRow = await findSessionJoinByTokenHash(env.DB, tokenHash);
  return sessionRow ? mapSessionRow(sessionRow) : null;
}

export async function loadD1Session(env: CloudflareEnv, sessionId: string, _capabilities?: unknown): Promise<WorkspaceSession | null> {
  const sessionRow = await findSessionJoin(env.DB, sessionId);
  if (!sessionRow) return null;
  return loadSessionRow(env, sessionRow);
}

export async function loadD1SessionByTokenHash(env: CloudflareEnv, tokenHash: string, _capabilities?: unknown): Promise<WorkspaceSession | null> {
  const sessionRow = await findSessionJoinByTokenHash(env.DB, tokenHash);
  if (!sessionRow) return null;
  return loadSessionRow(env, sessionRow);
}

export async function refreshD1Session(env: CloudflareEnv | undefined, sessionId: string) {
  if (!(await hasWorkspaceCoreTables(env))) return null;
  return loadD1Session(env!, sessionId);
}

export async function loadMailboxPage(
  env: CloudflareEnv,
  workspace: WorkspaceContext,
  query: MailboxQuery,
  knownMetrics?: WorkspaceMetrics
): Promise<MailboxPage> {
  const section = query.section ?? query.folder;
  const persistedFolder: MailFolder = query.folder;
  const repositoryQuery = {
    folder: persistedFolder,
    section,
    timestamp: query.cursor?.timestamp,
    cursorId: query.cursor?.id,
    limit: query.limit + 1,
    query: query.query,
    search: query.search,
    filter: query.filter,
    deliveryStatus: query.deliveryStatus
  };
  const metricsPromise = query.cursor
    ? Promise.resolve<WorkspaceMetrics | undefined>(undefined)
    : knownMetrics
      ? Promise.resolve(knownMetrics)
      : getMailboxMetrics(env.DB, workspace.userId);
  let messages;
  const searchHitFields = query.search ? buildFtsSearchPlan(query.search).hitFields : [];
  let searchTotal = 0;
  if (section === 'drafts') {
    const page = await listDraftPage(env.DB, workspace.userId, repositoryQuery);
    messages = (page.results ?? []).map((row) => mapDraftRow(row, workspace.profile, searchHitFields));
    searchTotal = Number(page.results?.[0]?.search_total ?? 0);
  } else if (section === 'sent') {
    const page = await listWorkspaceMessagePage(env.DB, workspace.userId, repositoryQuery);
    messages = (page.results ?? []).map((row) => mapWorkspaceMessageRow(row, mapPageDeliveryStatus(row), searchHitFields));
    searchTotal = Number(page.results?.[0]?.search_total ?? 0);
  } else {
    const [workspacePage, inboundPage] = await Promise.all([
      listWorkspaceMessagePage(env.DB, workspace.userId, repositoryQuery),
      listInboundMessageSummaryPage(env.DB, workspace.userId, repositoryQuery)
    ]);
    messages = sortMessages([
      ...(workspacePage.results ?? []).map((row) => mapWorkspaceMessageRow(row, undefined, searchHitFields)),
      ...(inboundPage.results ?? []).map((row) => ({ ...mapInboundRow(row, workspace.profile, searchHitFields), body: '' }))
    ]);
    searchTotal = Number(workspacePage.results?.[0]?.search_total ?? 0) + Number(inboundPage.results?.[0]?.search_total ?? 0);
  }

  const hasMore = messages.length > query.limit;
  const visible = messages.slice(0, query.limit);
  const last = visible.at(-1);
  const metrics = await metricsPromise;
  return {
    folder: section,
    messages: visible,
    nextCursor: hasMore && last ? encodeMailboxCursor({
      folder: persistedFolder,
      section,
      timestamp: last.sentAt,
      id: last.id,
      query: query.query,
      filter: query.filter,
      deliveryStatus: query.deliveryStatus
    }) : null,
    hasMore,
    limit: query.limit,
    query: query.query,
    filter: query.filter,
    deliveryStatus: query.deliveryStatus,
    ...(query.search && !query.cursor ? { searchTotal, searchHitFields } : {}),
    ...(metrics ? { metrics } : {})
  };
}

interface MailboxSummaryQuery {
  section?: MailboxSection;
  timestamp?: string;
  cursorId?: string;
  limit: number;
  query: string;
  search: MailSearchQuery | null;
  filter: MailboxFilter;
}

async function listInboundMessageSummaryPage(
  db: D1Database,
  userId: string,
  input: MailboxSummaryQuery
) {
  const searchPlan = input.search ? buildFtsSearchPlan(input.search) : null;
  const wantsTrash = input.search?.filters.is.includes('trash') ?? false;
  const wantsArchive = input.search?.filters.is.includes('archived') ?? false;
  const conditions = [
    'e.owner_user_id = ?',
    wantsTrash ? 's.deleted_at IS NOT NULL' : 's.deleted_at IS NULL',
    wantsArchive ? 's.archived_at IS NOT NULL' :
      wantsTrash ? '1 = 1' :
      input.section === 'archive' ? 's.archived_at IS NOT NULL' : 'COALESCE(s.archived_at, NULL) IS NULL',
    input.filter === 'unread'
      ? 'COALESCE(s.is_read, 0) = 0'
      : input.filter === 'starred'
        ? 'COALESCE(s.is_starred, 0) = 1'
        : '1 = 1'
  ];
  const bindings: unknown[] = [userId];
  if (searchPlan?.expression) {
    conditions.push('workspace_search_fts MATCH ?');
    bindings.push(searchPlan.expression);
  }
  if (input.search) {
    for (const value of input.search.filters.is) {
      if (value === 'unread') conditions.push('COALESCE(s.is_read, 0) = 0');
      if (value === 'starred') conditions.push('COALESCE(s.is_starred, 0) = 1');
    }
    if (input.search.filters.hasAttachment) {
      conditions.push('EXISTS (SELECT 1 FROM workspace_attachments AS search_attachment WHERE search_attachment.user_id = e.owner_user_id AND search_attachment.message_id = e.id)');
    }
    for (const value of input.search.filters.after) {
      conditions.push('e."timestamp" >= ?');
      bindings.push(`${value}T00:00:00.000Z`);
    }
    for (const value of input.search.filters.before) {
      conditions.push('e."timestamp" < ?');
      bindings.push(`${value}T00:00:00.000Z`);
    }
    if (input.search.filters.status.length) conditions.push('1 = 0');
  }
  if (input.timestamp && input.cursorId) {
    conditions.push(`(e."timestamp" < ? OR (e."timestamp" = ? AND ('email:' || e.id) < ?))`);
    bindings.push(input.timestamp, input.timestamp, input.cursorId);
  }
  bindings.push(input.limit);

  const searchJoins = input.search ? `
    JOIN workspace_search_documents AS search_document
      ON search_document.user_id = e.owner_user_id AND search_document.entity_kind = 'inbound' AND search_document.entity_id = e.id
    ${searchPlan?.expression ? 'JOIN workspace_search_fts ON workspace_search_fts.rowid = search_document.id' : ''}` : '';
  const searchSnippet = input.search
    ? searchPlan?.expression
      ? `snippet(workspace_search_fts, -1, char(57344), char(57345), ' … ', 16)`
      : `substr(search_document.subject_text, 1, 160)`
    : `NULL`;

  const pageSelect = `
    SELECT e.id AS email_id, e."from", e."to", e.subject, e."timestamp", e.snippet,
      e.message_id, e.in_reply_to, e."references", e.thread_key, s.archived_at,
      COALESCE(s.is_read, 0) AS is_read, COALESCE(s.is_starred, 0) AS is_starred,
      ${searchSnippet} AS search_snippet
    FROM email_messages AS e
    ${searchJoins}
    LEFT JOIN workspace_email_states AS s
      ON s.user_id = ? AND s.email_message_id = e.id
    WHERE ${conditions.join(' AND ')}`;
  const pageSql = input.search
    ? `SELECT search_rows.*, COUNT(*) OVER() AS search_total FROM (${pageSelect}) AS search_rows
       ORDER BY search_rows."timestamp" DESC, ('email:' || search_rows.email_id) DESC LIMIT ?`
    : `${pageSelect} ORDER BY e."timestamp" DESC, ('email:' || e.id) DESC LIMIT ?`;
  return db.prepare(pageSql).bind(userId, ...bindings).all<WorkspaceInboundRow>();
}

export async function loadWorkspaceSnapshot(
  env: CloudflareEnv,
  workspace: WorkspaceContext,
  options: WorkspaceSnapshotOptions | number = {}
): Promise<{ workspace: WorkspaceSnapshot }> {
  const normalized = typeof options === 'number' ? { limit: options } : options;
  const activeFolder = normalized.activeFolder ?? 'inbox';
  const persistedFolder: MailFolder = activeFolder === 'archive' ? 'inbox' : activeFolder;
  const metrics = await getMailboxMetrics(env.DB, workspace.userId);
  const page = await loadMailboxPage(env, workspace, {
    folder: persistedFolder,
    section: activeFolder,
    cursor: null,
    limit: normalized.limit ?? 40,
    query: normalized.query ?? '',
    search: normalized.query ? parseMailSearchQuery(normalized.query) : null,
    filter: normalized.filter ?? 'all',
    deliveryStatus: normalized.deliveryStatus ?? null
  }, metrics);
  const mailbox: MailboxState = { inbox: [], sent: [], drafts: [] };
  mailbox[persistedFolder] = page.messages;
  const mailboxPages: Partial<Record<MailboxSection, MailboxPage>> = { [activeFolder]: page };
  const snapshot: WorkspaceSnapshot = {
    profile: workspace.profile,
    metrics,
    activeFolder,
    activePage: page,
    mailbox,
    mailboxPages,
    outboundSenderEmail: env.OUTBOUND_FROM_EMAIL?.trim() || null
  };
  return { workspace: snapshot };
}
