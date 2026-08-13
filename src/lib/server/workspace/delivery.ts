import type { CloudflareEnv } from '$lib/server/cloudflare';
import { normalizeResendWebhookEvent } from '$lib/server/resend-webhook';
import { getWorkspaceCapabilities, hasWorkspaceCoreTables } from '$lib/server/db/capabilities';
import { findDeliveryDetailRows, findOutboundByProviderMessageId, hasOutboundEvent, insertOutboundEvent, upsertOutboundReceipt, upsertOutboundStatus } from '$lib/server/db/deliveries';
import { findMessage, mapEventRowToDeliveryEvent, memoryDeliveryDetail, nowIso, serializeOutboundEventInsert, serializeOutboundReceiptForUpsert, serializeOutboundStatusForUpsert, type DeliveryDetail, type WorkspaceSession } from '$lib/server/workspace/shared';

export async function getWorkspaceMessageDeliveryDetail(env: CloudflareEnv | undefined, session: WorkspaceSession, messageId: string) {
  const message = findMessage(session, messageId);
  if (!message || message.folder !== 'sent' || message.source !== 'workspace') return null;
  if (session.storage !== 'd1' || !(await hasWorkspaceCoreTables(env))) return memoryDeliveryDetail(message);
  const capabilities = await getWorkspaceCapabilities(env);
  const { receipt, events: eventRows } = await findDeliveryDetailRows(env!.DB, session.userId, messageId, capabilities);
  const events = eventRows.map(mapEventRowToDeliveryEvent);
  if (!receipt && !events.length) return null;
  if (!events.length && receipt) events.push({ id: `local:${messageId}:${receipt.last_event ?? 'submission'}`, type: receipt.last_event ?? 'submission', createdAt: receipt.last_event_at ?? nowIso(), summary: receipt.response_preview || '这封邮件已经写入当前工作台的出站投递记录。', payloadPreview: JSON.stringify({ provider: receipt.provider, resultKind: receipt.result_kind, remoteStatus: receipt.remote_status }) });
  return { messageId, provider: receipt?.provider ?? null, resultKind: receipt?.result_kind ?? null, lastEvent: receipt?.last_event ?? events[0]?.type ?? null, lastEventAt: receipt?.last_event_at ?? events[0]?.createdAt ?? null, events } satisfies DeliveryDetail;
}

export async function applyResendDeliveryWebhook(env: CloudflareEnv | undefined, svixId: string, payload: unknown) {
  if (!env?.DB) throw new Error('运行时缺少 D1 绑定。');
  const capabilities = await getWorkspaceCapabilities(env);
  if (!capabilities.outboundStatuses || !capabilities.outboundReceipts || !capabilities.outboundEvents) throw new Error('出站回执相关数据表尚未迁移，请先执行最新的 D1 schema。');
  const event = normalizeResendWebhookEvent(payload as Parameters<typeof normalizeResendWebhookEvent>[0]);
  if (await hasOutboundEvent(env.DB, svixId)) return { duplicate: true, ignored: false, matched: true, messageId: null as string | null };
  const outboundRow = await findOutboundByProviderMessageId(env.DB, event.providerMessageId);
  const eventRecord = serializeOutboundEventInsert({ svixId, messageId: outboundRow?.message_id ?? event.providerMessageId, userId: outboundRow?.user_id ?? 'unmatched', provider: event.provider, providerMessageId: event.providerMessageId, eventType: event.eventType, eventCreatedAt: event.createdAt, summary: event.summary, payloadJson: event.payloadJson });
  if (!outboundRow) {
    await env.DB.batch([insertOutboundEvent(env.DB, eventRecord)]);
    return { duplicate: false, ignored: true, matched: false, messageId: null as string | null };
  }
  const shouldUpdateCurrent = !outboundRow.last_event_at || event.createdAt >= outboundRow.last_event_at;
  const nextState = { provider: event.provider, resultKind: event.resultKind, status: event.status, attempts: outboundRow.attempts, deliveredAt: event.deliveredAt ?? outboundRow.delivered_at, lastError: event.lastError, providerMessageId: event.providerMessageId, remoteStatus: outboundRow.remote_status, responsePreview: event.responsePreview };
  const statements: D1PreparedStatement[] = [insertOutboundEvent(env.DB, eventRecord)];
  if (shouldUpdateCurrent) {
    const status = {
      ...serializeOutboundStatusForUpsert(outboundRow.user_id, outboundRow.message_id, nextState),
      updatedAt: event.createdAt
    };
    const receipt = {
      ...serializeOutboundReceiptForUpsert(outboundRow.user_id, outboundRow.message_id, nextState),
      lastEvent: event.eventType,
      lastEventAt: event.createdAt,
      remoteStatus: outboundRow.remote_status,
      responsePreview: event.responsePreview,
      updatedAt: event.createdAt
    };
    statements.push(upsertOutboundStatus(env.DB, status), upsertOutboundReceipt(env.DB, receipt));
  }
  await env.DB.batch(statements);
  return { duplicate: false, ignored: !shouldUpdateCurrent, matched: true, messageId: outboundRow.message_id };
}
