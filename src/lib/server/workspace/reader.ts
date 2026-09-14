import type { MailMessage, MailboxSection } from '$lib/domain/mail';
import { fromInboundMessageId, isInboundMessageId } from '$lib/domain/mail';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { findOwnedInboundState } from '$lib/server/db/inbound';
import { mapInboundRow, mapWorkspaceMessageRow, type WorkspaceContext, type WorkspaceMessageRow } from '$lib/server/workspace/shared';

type WorkspaceReturnFolder = MailboxSection | 'trash' | 'settings';
const readerFolders = new Set<WorkspaceReturnFolder>(['inbox', 'sent', 'drafts', 'archive', 'trash', 'settings']);

/**
 * Read only the metadata needed to render MessageDetail.
 *
 * The canonical body is deliberately excluded from this query. The reader
 * loads it later through the existing authenticated body/detail endpoints.
 */
async function findOwnedReaderWorkspaceMessage(db: D1Database, userId: string, messageId: string) {
  return db.prepare(`
    SELECT id, folder, from_name, from_email, to_name, to_email,
      to_json, subject, preview, '' AS body, sent_at, labels_json, is_read, is_starred,
      message_id, in_reply_to, "references", thread_key, cc, cc_json, bcc_json,
      archived_at
    FROM workspace_messages
    WHERE user_id = ? AND id = ? AND folder IN ('inbox', 'sent') AND deleted_at IS NULL
  `).bind(userId, messageId).first<WorkspaceMessageRow>();
}

export async function readWorkspaceMessage(
  env: CloudflareEnv | undefined,
  session: WorkspaceContext,
  messageId: string
): Promise<MailMessage | null> {
  if (!env?.DB || session.storage !== 'd1') return null;

  if (isInboundMessageId(messageId)) {
    const row = await findOwnedInboundState(env.DB, session.userId, fromInboundMessageId(messageId), { includeBody: false });
    return row ? { ...mapInboundRow(row, session.profile), body: '' } : null;
  }

  const row = await findOwnedReaderWorkspaceMessage(env.DB, session.userId, messageId);
  return row ? mapWorkspaceMessageRow(row) : null;
}

function safeFolder(value: string | null, fallback: WorkspaceReturnFolder): WorkspaceReturnFolder {
  return value && readerFolders.has(value as WorkspaceReturnFolder) ? value as WorkspaceReturnFolder : fallback;
}

/** Keep only the workspace URL contract when returning from the standalone reader. */
export function buildWorkspaceBackHref(url: URL, message: MailMessage): string {
  const fallbackFolder: WorkspaceReturnFolder = message.archivedAt
    ? 'archive'
    : message.folder;
  const folder = safeFolder(url.searchParams.get('folder'), fallbackFolder);
  const query = url.searchParams.get('q')?.trim().slice(0, 200) ?? '';
  const filter = url.searchParams.get('filter');
  const params = new URLSearchParams({ folder, message: message.id });
  if (query) params.set('q', query);
  if (filter === 'unread' || filter === 'starred') params.set('filter', filter);
  return `/?${params.toString()}`;
}
