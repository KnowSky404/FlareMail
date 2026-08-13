import type { CloudflareEnv } from '$lib/server/cloudflare';
import { getWorkspaceCapabilities, hasWorkspaceCoreTables } from '$lib/server/db/capabilities';
import { deleteDraft, updateDraftStarred } from '$lib/server/db/drafts';
import {
  deleteMessage,
  softDeleteInboundState,
  updateMessageFlags,
  upsertInboundState
} from '$lib/server/db/messages';
import { deleteOutboundStatus } from '$lib/server/db/deliveries';
import { touchSession } from '$lib/server/db/sessions';
import { findMessage, fromInboundMessageId, isInboundMessageId, normalizePatch, nowIso, serializeWorkspace, type MessagePatch, type WorkspaceSession } from '$lib/server/workspace/shared';
import { refreshD1Session } from '$lib/server/workspace/mailbox';
import { persistMemorySession } from '$lib/server/workspace/session';

export async function patchWorkspaceMessage(env: CloudflareEnv | undefined, session: WorkspaceSession, messageId: string, patch: MessagePatch) {
  const currentMessage = findMessage(session, messageId);
  if (!currentMessage) return null;
  if (session.storage === 'd1' && await hasWorkspaceCoreTables(env)) {
    const capabilities = await getWorkspaceCapabilities(env);
    const timestamp = nowIso();
    const statements: D1PreparedStatement[] = [];
    if (isInboundMessageId(messageId)) {
      if (!capabilities.inboundStates) throw new Error('入站状态表尚未迁移，请先执行最新的 D1 schema。');
      statements.push(upsertInboundState(env!.DB, session.userId, fromInboundMessageId(messageId), patch.read ?? currentMessage.read, patch.starred ?? currentMessage.starred, timestamp));
    } else if (currentMessage.folder === 'drafts') {
      if (!capabilities.drafts) throw new Error('草稿表尚未迁移，请先执行最新的 D1 schema。');
      statements.push(updateDraftStarred(env!.DB, session.userId, messageId, patch.starred ?? currentMessage.starred, timestamp));
    } else statements.push(updateMessageFlags(env!.DB, session.userId, messageId, patch.read ?? currentMessage.read, patch.starred ?? currentMessage.starred, timestamp));
    statements.push(touchSession(env!.DB, session.id, timestamp));
    await env!.DB.batch(statements);
    const nextSession = await refreshD1Session(env, session.id);
    if (!nextSession) throw new Error('更新邮件状态后无法重新加载工作区。');
    const message = findMessage(nextSession, messageId);
    return message ? { message, workspace: serializeWorkspace(nextSession) } : null;
  }
  session.mailbox = {
    inbox: session.mailbox.inbox.map((m) => m.id === messageId ? normalizePatch(m, patch) : { ...m, labels: [...m.labels] }),
    sent: session.mailbox.sent.map((m) => m.id === messageId ? normalizePatch(m, patch) : { ...m, labels: [...m.labels] }),
    drafts: session.mailbox.drafts.map((m) => m.id === messageId ? normalizePatch(m, patch) : { ...m, labels: [...m.labels] })
  };
  persistMemorySession(session);
  const message = findMessage(session, messageId);
  return message ? { message, workspace: serializeWorkspace(session) } : null;
}

export async function deleteWorkspaceMessage(env: CloudflareEnv | undefined, session: WorkspaceSession, messageId: string) {
  const currentMessage = findMessage(session, messageId);
  if (!currentMessage) return null;
  const folder = currentMessage.folder;
  if (session.storage === 'd1' && await hasWorkspaceCoreTables(env)) {
    const capabilities = await getWorkspaceCapabilities(env);
    const timestamp = nowIso();
    const statements: D1PreparedStatement[] = [];
    if (isInboundMessageId(messageId)) {
      if (!capabilities.inboundStates) throw new Error('入站状态表尚未迁移，请先执行最新的 D1 schema。');
      statements.push(softDeleteInboundState(env!.DB, session.userId, fromInboundMessageId(messageId), currentMessage.read, currentMessage.starred, timestamp));
    } else if (folder === 'drafts') {
      if (!capabilities.drafts) throw new Error('草稿表尚未迁移，请先执行最新的 D1 schema。');
      statements.push(deleteDraft(env!.DB, session.userId, messageId));
    } else {
      statements.push(deleteMessage(env!.DB, session.userId, messageId));
      if (folder === 'sent' && capabilities.outboundStatuses) statements.push(deleteOutboundStatus(env!.DB, session.userId, messageId));
    }
    statements.push(touchSession(env!.DB, session.id, timestamp));
    await env!.DB.batch(statements);
    const nextSession = await refreshD1Session(env, session.id);
    if (!nextSession) throw new Error('删除邮件后无法重新加载工作区。');
    return { folder, workspace: serializeWorkspace(nextSession) };
  }
  session.mailbox = { inbox: session.mailbox.inbox.filter((m) => m.id !== messageId).map((m) => ({ ...m, labels: [...m.labels] })), sent: session.mailbox.sent.filter((m) => m.id !== messageId).map((m) => ({ ...m, labels: [...m.labels] })), drafts: session.mailbox.drafts.filter((m) => m.id !== messageId).map((m) => ({ ...m, labels: [...m.labels] })) };
  persistMemorySession(session);
  return { folder, workspace: serializeWorkspace(session) };
}
