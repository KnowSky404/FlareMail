import type { CloudflareEnv } from '$lib/server/cloudflare';
import { deliverOutboundMessage, type OutboundDeliveryState } from '$lib/server/outbound';
import { getWorkspaceCapabilities, hasWorkspaceCoreTables } from '$lib/server/db/capabilities';
import { deleteDraft } from '$lib/server/db/drafts';
import { insertMessage } from '$lib/server/db/messages';
import { touchSession } from '$lib/server/db/sessions';
import { insertOutboundEvent, insertOutboundStatus, upsertOutboundReceipt, upsertOutboundStatus } from '$lib/server/db/deliveries';
import { createSentMessage, findMessage, nowIso, serializeMessageForInsert, serializeOutboundEventInsert, serializeOutboundReceiptForUpsert, serializeOutboundStatusForUpsert, serializeWorkspace, sortMessages, type ComposeInput, type MailMessage, type WorkspaceSession } from '$lib/server/workspace/shared';
import { refreshD1Session } from '$lib/server/workspace/mailbox';
import { persistMemorySession } from '$lib/server/workspace/session';

const outboundInput = (message: MailMessage) => ({ messageId: message.id, fromName: message.fromName, fromEmail: message.fromEmail,
  toEmail: message.toEmail, cc: message.cc, subject: message.subject, text: message.body });

function applyDelivery(message: MailMessage, state: OutboundDeliveryState): MailMessage {
  return { ...message, deliveryStatus: state.status, deliveryAttempts: state.attempts, deliveryError: state.lastError,
    deliveredAt: state.deliveredAt, deliveryProvider: state.provider, deliveryResultKind: state.resultKind,
    deliveryRemoteStatus: state.remoteStatus, deliveryResponsePreview: state.responsePreview, deliveryLastEvent: 'submission',
    deliveryLastEventAt: state.deliveredAt ?? nowIso() };
}

function deliveryStatements(db: D1Database, userId: string, message: MailMessage, state: OutboundDeliveryState, capabilities: Awaited<ReturnType<typeof getWorkspaceCapabilities>>, retry = false) {
  const statements: D1PreparedStatement[] = [];
  if (!capabilities.outboundStatuses) return statements;
  const status = serializeOutboundStatusForUpsert(userId, message.id, state);
  statements.push(retry ? upsertOutboundStatus(db, status) : insertOutboundStatus(db, status));
  if (capabilities.outboundReceipts) statements.unshift(upsertOutboundReceipt(db, { ...serializeOutboundReceiptForUpsert(userId, message.id, state), lastEvent: 'submission', lastEventAt: message.deliveryLastEventAt ?? nowIso() }));
  if (capabilities.outboundEvents) {
    const event = serializeOutboundEventInsert({ svixId: `local:${message.id}:submission:${state.attempts}`, messageId: message.id, userId,
      provider: state.provider, providerMessageId: state.providerMessageId, eventType: 'submission', eventCreatedAt: message.deliveryLastEventAt ?? nowIso(),
      summary: state.responsePreview || state.lastError || '邮件已提交到出站 provider。', payloadJson: JSON.stringify({ provider: state.provider, resultKind: state.resultKind, status: state.status, remoteStatus: state.remoteStatus }) });
    statements.unshift(insertOutboundEvent(db, event));
  }
  return statements;
}

export async function sendWorkspaceMessage(env: CloudflareEnv | undefined, session: WorkspaceSession, input: ComposeInput) {
  const draftId = input.draftId?.trim() || undefined;
  const initialMessage = createSentMessage({ id: draftId, from: session.profile, toEmail: input.toEmail, subject: input.subject, body: input.body,
    cc: input.cc, deliveryStatus: 'queued', deliveryAttempts: 0, deliveryError: '', deliveredAt: null });
  const state = await deliverOutboundMessage(env, outboundInput(initialMessage), 0);
  const message = applyDelivery(initialMessage, state);
  if (session.storage === 'd1' && await hasWorkspaceCoreTables(env)) {
    const capabilities = await getWorkspaceCapabilities(env);
    const statements = deliveryStatements(env!.DB, session.userId, message, state, capabilities);
    statements.push(insertMessage(env!.DB, serializeMessageForInsert(session.userId, message)));
    statements.push(touchSession(env!.DB, session.id));
    if (draftId && capabilities.drafts) statements.unshift(deleteDraft(env!.DB, session.userId, draftId));
    await env!.DB.batch(statements);
    const nextSession = await refreshD1Session(env, session.id);
    if (!nextSession) throw new Error('发送邮件后无法重新加载工作区。');
    return { message, workspace: serializeWorkspace(nextSession) };
  }
  session.mailbox = { inbox: session.mailbox.inbox.map((m) => ({ ...m, labels: [...m.labels] })), sent: sortMessages([message, ...session.mailbox.sent.map((m) => ({ ...m, labels: [...m.labels] }))]), drafts: session.mailbox.drafts.filter((m) => m.id !== draftId).map((m) => ({ ...m, labels: [...m.labels] })) };
  persistMemorySession(session);
  return { message, workspace: serializeWorkspace(session) };
}

export async function retryWorkspaceMessageDelivery(env: CloudflareEnv | undefined, session: WorkspaceSession, messageId: string) {
  const currentMessage = findMessage(session, messageId);
  if (!currentMessage || currentMessage.folder !== 'sent' || currentMessage.source !== 'workspace') return null;
  const state = await deliverOutboundMessage(env, outboundInput(currentMessage), currentMessage.deliveryAttempts ?? 0);
  if (session.storage === 'd1' && await hasWorkspaceCoreTables(env)) {
    const capabilities = await getWorkspaceCapabilities(env);
    if (!capabilities.outboundStatuses) throw new Error('出站状态表尚未迁移，请先执行最新的 D1 schema。');
    const message = applyDelivery(currentMessage, state);
    const statements = deliveryStatements(env!.DB, session.userId, message, state, capabilities, true);
    statements.push(touchSession(env!.DB, session.id));
    await env!.DB.batch(statements);
    const nextSession = await refreshD1Session(env, session.id);
    if (!nextSession) throw new Error('更新投递状态后无法重新加载工作区。');
    const nextMessage = findMessage(nextSession, messageId);
    return nextMessage ? { message: nextMessage, workspace: serializeWorkspace(nextSession) } : null;
  }
  const message = applyDelivery(currentMessage, state);
  session.mailbox = { inbox: session.mailbox.inbox.map((m) => ({ ...m, labels: [...m.labels] })), sent: session.mailbox.sent.map((item) => item.id === messageId ? message : { ...item, labels: [...item.labels] }), drafts: session.mailbox.drafts.map((m) => ({ ...m, labels: [...m.labels] })) };
  persistMemorySession(session);
  return { message, workspace: serializeWorkspace(session) };
}
