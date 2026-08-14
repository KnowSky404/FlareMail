import type { CloudflareEnv } from '$lib/server/cloudflare';
import { getWorkspaceCapabilities, hasWorkspaceCoreTables } from '$lib/server/db/capabilities';
import {
  getMailboxMetrics,
  listDraftPage,
  listInboundMessagePage,
  listWorkspaceMessagePage,
  mapPageDeliveryStatus
} from '$lib/server/db/mailbox';
import { listDrafts } from '$lib/server/db/drafts';
import { listInboundMessages, listMessages } from '$lib/server/db/messages';
import { findSessionJoin, findSessionJoinByTokenHash } from '$lib/server/db/sessions';
import { listOutboundStatuses } from '$lib/server/db/deliveries';
import {
  mapDraftRow,
  mapInboundRow,
  mapUserRowToProfile,
  mapWorkspaceMessageRow,
  rowsToMailbox,
  serializeWorkspace,
  sortMessages,
  type MailboxPage,
  type WorkspaceContext,
  type WorkspaceSession
} from '$lib/server/workspace/shared';
import { encodeMailboxCursor, type MailboxQuery } from '$lib/server/workspace/mailbox-query';
import type { MailFolder, WorkspacePayload } from '$lib/domain/mail';

export { serializeWorkspace };

async function loadSessionRow(
  env: CloudflareEnv,
  sessionRow: NonNullable<Awaited<ReturnType<typeof findSessionJoin>>>,
  capabilities: Awaited<ReturnType<typeof getWorkspaceCapabilities>>
): Promise<WorkspaceSession> {
  const profile = mapUserRowToProfile(sessionRow);
  const [messageRows, draftRows, inboundRows, outboundRows] = await Promise.all([
    listMessages(env.DB, sessionRow.id),
    capabilities.drafts ? listDrafts(env.DB, sessionRow.id) : Promise.resolve({ results: [] }),
    listInboundMessages(env.DB, sessionRow.id, sessionRow.login_email, sessionRow.email, capabilities),
    listOutboundStatuses(env.DB, sessionRow.id, capabilities)
  ]);
  return {
    id: sessionRow.session_id, userId: sessionRow.id, profile,
    mailbox: rowsToMailbox(messageRows.results ?? [], draftRows.results ?? [], inboundRows.results ?? [], outboundRows.results ?? [], profile),
    incomingSequence: sessionRow.incoming_sequence, createdAt: sessionRow.created_at, updatedAt: sessionRow.updated_at, storage: 'd1'
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

export async function loadD1Session(env: CloudflareEnv, sessionId: string, capabilities?: Awaited<ReturnType<typeof getWorkspaceCapabilities>>): Promise<WorkspaceSession | null> {
  capabilities ??= await getWorkspaceCapabilities(env);
  const sessionRow = await findSessionJoin(env.DB, sessionId);
  if (!sessionRow) return null;
  return loadSessionRow(env, sessionRow, capabilities);
}

export async function loadD1SessionByTokenHash(env: CloudflareEnv, tokenHash: string, capabilities?: Awaited<ReturnType<typeof getWorkspaceCapabilities>>): Promise<WorkspaceSession | null> {
  capabilities ??= await getWorkspaceCapabilities(env);
  const sessionRow = await findSessionJoinByTokenHash(env.DB, tokenHash);
  if (!sessionRow) return null;
  return loadSessionRow(env, sessionRow, capabilities);
}

export async function refreshD1Session(env: CloudflareEnv | undefined, sessionId: string) {
  if (!(await hasWorkspaceCoreTables(env))) return null;
  return loadD1Session(env!, sessionId);
}

export async function loadMailboxPage(
  env: CloudflareEnv,
  workspace: WorkspaceContext,
  query: MailboxQuery
): Promise<MailboxPage> {
  const repositoryQuery = {
    folder: query.folder,
    timestamp: query.cursor?.timestamp,
    cursorId: query.cursor?.id,
    limit: query.limit + 1,
    query: query.query,
    filter: query.filter,
    deliveryStatus: query.deliveryStatus
  };
  const metricsPromise = query.cursor ? Promise.resolve<Awaited<ReturnType<typeof getMailboxMetrics>> | undefined>(undefined) : getMailboxMetrics(env.DB, workspace.userId);
  let messages;
  if (query.folder === 'drafts') {
    const page = await listDraftPage(env.DB, workspace.userId, repositoryQuery);
    messages = (page.results ?? []).map((row) => mapDraftRow(row, workspace.profile));
  } else if (query.folder === 'sent') {
    const page = await listWorkspaceMessagePage(env.DB, workspace.userId, repositoryQuery);
    messages = (page.results ?? []).map((row) => mapWorkspaceMessageRow(row, mapPageDeliveryStatus(row)));
  } else {
    const [workspacePage, inboundPage] = await Promise.all([
      listWorkspaceMessagePage(env.DB, workspace.userId, repositoryQuery),
      listInboundMessagePage(env.DB, workspace.userId, repositoryQuery)
    ]);
    messages = sortMessages([
      ...(workspacePage.results ?? []).map((row) => mapWorkspaceMessageRow(row)),
      ...(inboundPage.results ?? []).map((row) => mapInboundRow(row, workspace.profile))
    ]);
  }

  const hasMore = messages.length > query.limit;
  const visible = messages.slice(0, query.limit);
  const last = visible.at(-1);
  return {
    folder: query.folder,
    messages: visible,
    nextCursor: hasMore && last ? encodeMailboxCursor({
      folder: query.folder,
      timestamp: last.sentAt,
      id: last.id
    }) : null,
    hasMore,
    limit: query.limit,
    query: query.query,
    filter: query.filter,
    deliveryStatus: query.deliveryStatus,
    ...(await metricsPromise ? { metrics: await metricsPromise } : {})
  };
}

export async function loadWorkspaceSnapshot(
  env: CloudflareEnv,
  workspace: WorkspaceContext,
  limit = 40
): Promise<{ workspace: WorkspacePayload; pages: Record<MailFolder, MailboxPage> }> {
  const folders: MailFolder[] = ['inbox', 'sent', 'drafts'];
  const loaded = await Promise.all(folders.map((folder) => loadMailboxPage(env, workspace, {
    folder,
    cursor: null,
    limit,
    query: '',
    filter: 'all',
    deliveryStatus: null
  })));
  const pages = Object.fromEntries(loaded.map((page) => [page.folder, page])) as Record<MailFolder, MailboxPage>;
  return {
    workspace: {
      profile: workspace.profile,
      mailbox: {
        inbox: pages.inbox.messages,
        sent: pages.sent.messages,
        drafts: pages.drafts.messages
      },
      metrics: pages.inbox.metrics ?? { inboxCount: 0, sentCount: 0, draftsCount: 0, unreadCount: 0, starredCount: 0 }
    },
    pages
  };
}
