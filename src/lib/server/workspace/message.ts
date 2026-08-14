import type { CloudflareEnv } from '$lib/server/cloudflare';
import { getMailboxMetrics } from '$lib/server/db/mailbox';
import { findOwnedInboundState } from '$lib/server/db/inbound';
import { getWorkspaceCapabilities } from '$lib/server/db/capabilities';
import { deleteDraft } from '$lib/server/db/drafts';
import { deleteOutboundStatus } from '$lib/server/db/deliveries';
import { deleteMessage, findOwnedWorkspaceMessage, softDeleteInboundState, updateMessageFlags, upsertInboundState } from '$lib/server/db/messages';
import { fromInboundMessageId, isInboundMessageId, mapInboundRow, mapWorkspaceMessageRow, normalizePatch, type MailMessage, type MessagePatch, type WorkspaceContext } from '$lib/server/workspace/shared';

async function findOwnedMessage(env: CloudflareEnv, session: WorkspaceContext, messageId: string): Promise<MailMessage | null> {
  if (isInboundMessageId(messageId)) {
    const row = await findOwnedInboundState(env.DB, session.userId, fromInboundMessageId(messageId));
    return row ? mapInboundRow(row, session.profile) : null;
  }
  const row = await findOwnedWorkspaceMessage(env.DB, session.userId, messageId);
  return row ? mapWorkspaceMessageRow(row) : null;
}

export async function patchWorkspaceMessage(env: CloudflareEnv | undefined, session: WorkspaceContext, messageId: string, patch: MessagePatch) {
  if (!env?.DB || session.storage !== 'd1') throw new Error('工作区存储未配置，无法更新邮件。');
  const currentMessage = await findOwnedMessage(env, session, messageId);
  if (!currentMessage) return null;
  const capabilities = await getWorkspaceCapabilities(env);
  const timestamp = new Date().toISOString();
  let statement: D1PreparedStatement;
  if (isInboundMessageId(messageId)) {
    if (!capabilities.inboundStates) throw new Error('入站状态表尚未迁移，请先执行最新的 D1 schema。');
    statement = upsertInboundState(env.DB, session.userId, fromInboundMessageId(messageId), patch.read ?? currentMessage.read, patch.starred ?? currentMessage.starred, timestamp);
  } else if (currentMessage.folder === 'drafts') {
    if (!capabilities.drafts) throw new Error('草稿表尚未迁移，请先执行最新的 D1 schema。');
    statement = (await import('$lib/server/db/drafts')).updateDraftStarred(env.DB, session.userId, messageId, patch.starred ?? currentMessage.starred, timestamp);
  } else {
    statement = updateMessageFlags(env.DB, session.userId, messageId, patch.read ?? currentMessage.read, patch.starred ?? currentMessage.starred, timestamp);
  }
  await env.DB.batch([statement]);
  return { message: normalizePatch(currentMessage, patch), metrics: await getMailboxMetrics(env.DB, session.userId) };
}

export async function deleteWorkspaceMessage(env: CloudflareEnv | undefined, session: WorkspaceContext, messageId: string) {
  if (!env?.DB || session.storage !== 'd1') throw new Error('工作区存储未配置，无法删除邮件。');
  const currentMessage = await findOwnedMessage(env, session, messageId);
  if (!currentMessage) return null;
  const capabilities = await getWorkspaceCapabilities(env);
  const timestamp = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (isInboundMessageId(messageId)) {
    if (!capabilities.inboundStates) throw new Error('入站状态表尚未迁移，请先执行最新的 D1 schema。');
    statements.push(softDeleteInboundState(env.DB, session.userId, fromInboundMessageId(messageId), currentMessage.read, currentMessage.starred, timestamp));
  } else if (currentMessage.folder === 'drafts') {
    if (!capabilities.drafts) throw new Error('草稿表尚未迁移，请先执行最新的 D1 schema。');
    statements.push(deleteDraft(env.DB, session.userId, messageId));
  } else {
    statements.push(deleteMessage(env.DB, session.userId, messageId));
    if (currentMessage.folder === 'sent' && capabilities.outboundStatuses) statements.push(deleteOutboundStatus(env.DB, session.userId, messageId));
  }
  await env.DB.batch(statements);
  return { removedId: messageId, folder: currentMessage.folder, metrics: await getMailboxMetrics(env.DB, session.userId) };
}
