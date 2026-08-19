import { getDeliveryRetryEligibility, type DeliveryRetryEligibilityCode } from '$lib/domain/mail';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { normalizeResendWebhookEvent, type NormalizedResendWebhookEvent } from '$lib/server/resend-webhook';
import { getWorkspaceCapabilities, hasWorkspaceCoreTables } from '$lib/server/db/capabilities';
import {
  assignOutboundEvent,
  findDeliveryDetailRows,
  findDeliveryStatus,
  findOutboundByProviderMessageId,
  hasOutboundEvent,
  insertOutboundEvent,
  listUnmatchedOutboundEvents,
  reconcileDeliveryStatus,
  updateOutboundReceiptForCurrentEvent
} from '$lib/server/db/deliveries';
import { mapEventRowToDeliveryEvent, mapWorkspaceMessageRow, nowIso, serializeOutboundEventInsert, type DeliveryDetail, type WorkspaceContext } from '$lib/server/workspace/shared';
import { findOwnedWorkspaceMessage } from '$lib/server/db/messages';

export class DeliveryPersistenceError extends Error {
  readonly code = 'DELIVERY_PERSISTENCE_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryPersistenceError';
  }
}

export type PersistedDeliveryRetryFailure = DeliveryRetryEligibilityCode
  | 'delivery_state_missing'
  | 'message_idempotency_key_missing'
  | 'message_idempotency_key_mismatch'
  | 'attempt_not_started';

export class DeliveryNotRetryableError extends Error {
  readonly code = 'DELIVERY_NOT_RETRYABLE';

  constructor(readonly reason: PersistedDeliveryRetryFailure, message: string) {
    super(message);
    this.name = 'DeliveryNotRetryableError';
  }
}

export interface PersistedDeliveryRetryInput {
  status: Parameters<typeof getDeliveryRetryEligibility>[0]['status'];
  resultKind: Parameters<typeof getDeliveryRetryEligibility>[0]['resultKind'];
  attempts: number;
  idempotencyKey: string | null | undefined;
  messageIdempotencyKey: string | null | undefined;
  attemptStartedAt: string | null | undefined;
  now?: string | number | Date;
}

/**
 * Server-side final validation for a same-key retry. The domain helper owns
 * status/result/age rules; this layer additionally verifies durable database
 * invariants that a client cannot be trusted to provide.
 */
export function assertPersistedDeliveryRetryable(input: PersistedDeliveryRetryInput) {
  if (!input.messageIdempotencyKey?.trim()) {
    throw new DeliveryNotRetryableError('message_idempotency_key_missing', 'The persisted message idempotency key is missing.');
  }
  if (!input.idempotencyKey?.trim()) {
    throw new DeliveryNotRetryableError('idempotency_key_missing', 'The persisted delivery idempotency key is missing.');
  }
  if (input.messageIdempotencyKey !== input.idempotencyKey) {
    throw new DeliveryNotRetryableError('message_idempotency_key_mismatch', 'The persisted message and delivery idempotency keys do not match.');
  }
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 1) {
    throw new DeliveryNotRetryableError('attempt_not_started', 'The persisted delivery has no completed attempt to retry.');
  }

  const eligibility = getDeliveryRetryEligibility({
    status: input.status,
    resultKind: input.resultKind,
    idempotencyKey: input.idempotencyKey,
    attemptStartedAt: input.attemptStartedAt,
    now: input.now
  });
  if (!eligibility.eligible) {
    throw new DeliveryNotRetryableError(eligibility.code, eligibility.reason);
  }
  return eligibility;
}

export async function getWorkspaceMessageDeliveryDetail(env: CloudflareEnv | undefined, session: WorkspaceContext, messageId: string) {
  if (session.storage !== 'd1' || !env?.DB || !(await hasWorkspaceCoreTables(env))) return null;
  const row = await findOwnedWorkspaceMessage(env.DB, session.userId, messageId);
  const message = row ? mapWorkspaceMessageRow(row) : null;
  if (!message || message.folder !== 'sent' || message.source !== 'workspace') return null;
  const capabilities = await getWorkspaceCapabilities(env);
  const { receipt, events: eventRows } = await findDeliveryDetailRows(env!.DB, session.userId, messageId, capabilities);
  const events = eventRows.map(mapEventRowToDeliveryEvent);
  if (!receipt && !events.length) return null;
  if (!events.length && receipt) events.push({ id: `local:${messageId}:${receipt.last_event ?? 'submission'}`, type: receipt.last_event ?? 'submission', createdAt: receipt.last_event_at ?? nowIso(), summary: receipt.response_preview || '这封邮件已经写入当前工作台的出站投递记录。', payloadPreview: JSON.stringify({ provider: receipt.provider, resultKind: receipt.result_kind, remoteStatus: receipt.remote_status }) });
  return { messageId, provider: receipt?.provider ?? null, resultKind: receipt?.result_kind ?? null, lastEvent: receipt?.last_event ?? events[0]?.type ?? null, lastEventAt: receipt?.last_event_at ?? events[0]?.createdAt ?? null, events } satisfies DeliveryDetail;
}

export async function applyResendDeliveryWebhook(env: CloudflareEnv | undefined, svixId: string, payload: unknown) {
  if (!env?.DB) throw new DeliveryPersistenceError('D1 binding is unavailable.');
  const capabilities = await getWorkspaceCapabilities(env);
  if (!capabilities.outboundStatuses || !capabilities.outboundReceipts || !capabilities.outboundEvents) {
    throw new DeliveryPersistenceError('D1 delivery schema is unavailable.');
  }
  const event = normalizeResendWebhookEvent(payload as Parameters<typeof normalizeResendWebhookEvent>[0]);
  if (await hasOutboundEvent(env.DB, svixId)) return { duplicate: true, ignored: false, matched: true, messageId: null as string | null };
  const outboundRow = await findOutboundByProviderMessageId(env.DB, event.providerMessageId);
  const eventRecord = serializeOutboundEventInsert({ svixId, messageId: outboundRow?.message_id ?? event.providerMessageId, userId: outboundRow?.user_id ?? 'unmatched', provider: event.provider, providerMessageId: event.providerMessageId, eventType: event.eventType, eventCreatedAt: event.createdAt, summary: event.summary, payloadJson: event.payloadJson });
  if (!outboundRow) {
    try {
      await env.DB.batch([insertOutboundEvent(env.DB, eventRecord)]);
    } catch (error) {
      if (error instanceof Error && /unique constraint|constraint failed/iu.test(error.message)) {
        return { duplicate: true, ignored: true, matched: false, messageId: null as string | null };
      }
      throw error;
    }
    return { duplicate: false, ignored: true, matched: false, messageId: null as string | null };
  }

  const statements: D1PreparedStatement[] = [
    insertOutboundEvent(env.DB, eventRecord),
    ...reconciliationStatements(env.DB, outboundRow, event)
  ];
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (error instanceof Error && /unique constraint|constraint failed/iu.test(error.message)) {
      return { duplicate: true, ignored: true, matched: true, messageId: outboundRow.message_id };
    }
    throw error;
  }
  const current = await findDeliveryStatus(env.DB, outboundRow.user_id, outboundRow.message_id);
  const ignored = !event.statusUpdate || current?.last_event !== event.eventType || current.last_event_at !== event.createdAt;
  return { duplicate: false, ignored, matched: true, messageId: outboundRow.message_id };
}

function reconciliationStatements(
  db: D1Database,
  outboundRow: NonNullable<Awaited<ReturnType<typeof findOutboundByProviderMessageId>>>,
  event: NormalizedResendWebhookEvent
) {
  if (!event.statusUpdate || !event.resultKind) return [];
  return [
    reconcileDeliveryStatus(db, {
      messageId: outboundRow.message_id,
      targetStatus: event.statusUpdate,
      targetRank: deliveryPriority(event.statusUpdate),
      provider: event.provider,
      providerMessageId: event.providerMessageId,
      lastError: event.lastError,
      eventType: event.eventType,
      eventCreatedAt: event.createdAt
    }),
    updateOutboundReceiptForCurrentEvent(db, {
      messageId: outboundRow.message_id,
      userId: outboundRow.user_id,
      provider: event.provider,
      resultKind: event.resultKind,
      remoteStatus: outboundRow.remote_status,
      responsePreview: event.responsePreview,
      lastEvent: event.eventType,
      lastEventAt: event.createdAt,
      createdAt: event.createdAt,
      updatedAt: event.createdAt
    })
  ];
}

function deliveryPriority(status: string) {
  if (['draft'].includes(status)) return 0;
  if (['queued'].includes(status)) return 1;
  if (['submitting'].includes(status)) return 2;
  if (['submitted'].includes(status)) return 3;
  if (['sent', 'delayed'].includes(status)) return 4;
  if (['bounced', 'failed'].includes(status)) return 5;
  if (['complained', 'suppressed'].includes(status)) return 6;
  if (status === 'delivered') return 7;
  return -1;
}

export async function reconcilePendingResendEvents(env: CloudflareEnv, providerMessageId: string) {
  const outboundRow = await findOutboundByProviderMessageId(env.DB, providerMessageId);
  if (!outboundRow) return 0;
  const pending = await listUnmatchedOutboundEvents(env.DB, providerMessageId);
  let reconciled = 0;
  for (const row of pending.results ?? []) {
    let event: NormalizedResendWebhookEvent;
    try {
      event = normalizeResendWebhookEvent(JSON.parse(row.payload_json));
    } catch {
      continue;
    }
    await env.DB.batch([
      assignOutboundEvent(env.DB, row.svix_id, outboundRow.message_id, outboundRow.user_id),
      ...reconciliationStatements(env.DB, outboundRow, event)
    ]);
    reconciled += 1;
  }
  return reconciled;
}
