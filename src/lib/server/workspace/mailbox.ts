import type { CloudflareEnv } from '$lib/server/cloudflare';
import { getWorkspaceCapabilities, hasWorkspaceCoreTables } from '$lib/server/db/capabilities';
import { listDrafts } from '$lib/server/db/drafts';
import { listInboundMessages, listMessages } from '$lib/server/db/messages';
import { findSessionJoin } from '$lib/server/db/sessions';
import { listOutboundStatuses } from '$lib/server/db/deliveries';
import { mapUserRowToProfile, rowsToMailbox, serializeWorkspace, type WorkspaceSession } from '$lib/server/workspace/shared';

export { serializeWorkspace };

export async function loadD1Session(env: CloudflareEnv, sessionId: string, capabilities?: Awaited<ReturnType<typeof getWorkspaceCapabilities>>): Promise<WorkspaceSession | null> {
  capabilities ??= await getWorkspaceCapabilities(env);
  const sessionRow = await findSessionJoin(env.DB, sessionId);
  if (!sessionRow) return null;
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

export async function refreshD1Session(env: CloudflareEnv | undefined, sessionId: string) {
  if (!(await hasWorkspaceCoreTables(env))) return null;
  return loadD1Session(env!, sessionId);
}
