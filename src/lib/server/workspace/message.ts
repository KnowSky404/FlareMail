import type { CloudflareEnv } from '$lib/server/cloudflare';
import { getMailboxMetrics } from '$lib/server/db/mailbox';
import { findOwnedInboundState } from '$lib/server/db/inbound';
import { getWorkspaceCapabilities } from '$lib/server/db/capabilities';
import { findOwnedDraft } from '$lib/server/db/drafts';
import { findOwnedWorkspaceMessage, updateMessageFlags, patchInboundFlags } from '$lib/server/db/messages';
import { mailboxIdentityFilterExists } from '$lib/server/db/mail-identities';
import type { MailboxIdentityFilter } from '$lib/domain/mail';
import { ApiError } from '$lib/server/http/api';
import { fromInboundMessageId, isInboundMessageId, mapDraftRow, mapInboundRow, mapWorkspaceMessageRow, type MailMessage, type MessagePatch, type WorkspaceContext } from '$lib/server/workspace/shared';
import { moveWorkspaceMessageToTrash } from '$lib/server/workspace/trash';

async function findOwnedMessage(env: CloudflareEnv, session: WorkspaceContext, messageId: string): Promise<MailMessage | null> {
  if (isInboundMessageId(messageId)) {
    const row = await findOwnedInboundState(env.DB, session.userId, fromInboundMessageId(messageId), { includeBody: false });
    return row ? mapInboundRow(row, session.profile) : null;
  }
  const row = await findOwnedWorkspaceMessage(env.DB, session.userId, messageId, { includeBody: false });
  if (row) return row.deleted_at ? null : mapWorkspaceMessageRow(row);
  const draft = await findOwnedDraft(env.DB, session.userId, messageId);
  return draft ? mapDraftRow(draft, session.profile) : null;
}

export async function patchWorkspaceMessage(env: CloudflareEnv | undefined, session: WorkspaceContext, messageId: string, patch: MessagePatch, identityFilter: MailboxIdentityFilter | null = null) {
  if (!env?.DB || session.storage !== 'd1') throw new Error('工作区存储未配置，无法更新邮件。');
  if (identityFilter && !(await mailboxIdentityFilterExists(env.DB, session.userId, identityFilter))) {
    throw new ApiError(404, 'MAIL_IDENTITY_NOT_FOUND', '所选邮件身份不存在或不属于当前工作区。');
  }
  const currentMessage = await findOwnedMessage(env, session, messageId);
  if (!currentMessage) return null;
  const capabilities = await getWorkspaceCapabilities(env);
  const timestamp = new Date().toISOString();
  let statement: D1PreparedStatement | undefined;
  if (isInboundMessageId(messageId)) {
    if (!capabilities.inboundStates) throw new Error('入站状态表尚未迁移，请先执行最新的 D1 schema。');
    statement = patchInboundFlags(env.DB, session.userId, fromInboundMessageId(messageId), patch, timestamp);
  } else if (currentMessage.folder === 'drafts') {
    if (!capabilities.drafts) throw new Error('草稿表尚未迁移，请先执行最新的 D1 schema。');
    // Drafts have no read flag; a read-only patch must not rewrite their star.
    if (patch.starred !== undefined) statement = (await import('$lib/server/db/drafts')).updateDraftStarred(env.DB, session.userId, messageId, patch.starred, timestamp);
  } else {
    statement = updateMessageFlags(env.DB, session.userId, messageId, patch, timestamp);
  }
  if (statement) await env.DB.batch([statement]);
  const [message, metrics] = await Promise.all([
    findOwnedMessage(env, session, messageId),
    getMailboxMetrics(env.DB, session.userId, identityFilter)
  ]);
  if (!message) return null;
  return {
    message: { ...message, body: '' },
    metrics,
    metricsScope: { identityFilter }
  };
}

export async function deleteWorkspaceMessage(env: CloudflareEnv | undefined, session: WorkspaceContext, messageId: string) {
  const result = await moveWorkspaceMessageToTrash(env, session, messageId);
  if (!result || !env?.DB) return null;
  return {
    ...result,
    removedId: messageId,
    metrics: await getMailboxMetrics(env.DB, session.userId),
    metricsScope: { identityFilter: null }
  };
}
