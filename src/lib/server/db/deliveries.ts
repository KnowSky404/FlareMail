import type { DeliveryEventType, DeliveryResultKind, DeliveryStatus, WorkspaceCapabilities, WorkspaceOutboundEventRow, WorkspaceOutboundReceiptRow, WorkspaceOutboundStatusRow } from '$lib/server/workspace/shared';
import { isDeliveryTerminal, type DeliveryAttentionItem } from '$lib/domain/mail';
import { currentDeliveryAttentionStatement } from './delivery-attention';

const terminalStatuses = "'delivered', 'bounced', 'failed', 'complained', 'suppressed'";
const deferredPath = '$._flaremailDeferred';
const claimPath = '$._flaremailReplayClaim';

export interface DeferredEventClaim { svixId: string; token: string }

function replayGuard(claim?: DeferredEventClaim) {
  return claim
    ? { sql: `AND EXISTS (
      SELECT 1 FROM workspace_outbound_events claim
      WHERE claim.svix_id = ? AND json_extract(claim.payload_json, '${claimPath}') = ?
    )`, args: [claim.svixId, claim.token] }
    : { sql: '', args: [] };
}
const wasDeferred = `CASE WHEN json_valid(payload_json)
  THEN COALESCE(json_extract(payload_json, '${deferredPath}') = 1, 0) ELSE 0 END`;
const unconfirmedAttempt = (alias: string) => `EXISTS (
  SELECT 1 FROM workspace_delivery_attempts AS attempt
  WHERE attempt.message_id = ${alias}.message_id AND attempt.attempt_number = ${alias}.attempts
    AND attempt.provider_message_id IS NOT ${alias}.provider_message_id
    AND attempt.completed_at IS NULL AND attempt.error IS NULL
)`;

const newerProviderEvent = (alias: string) => `
  SELECT 1 FROM workspace_outbound_events newer
  WHERE newer.message_id = ${alias}.message_id AND newer.user_id = ${alias}.user_id
    AND newer.provider_message_id = ${alias}.provider_message_id
    AND newer.event_type IN ('email.sent', 'email.delivery_delayed') AND NOT (${wasDeferred})
    AND julianday(newer.event_created_at) > julianday(?) AND julianday(newer.event_created_at) <= julianday(attempt.started_at)
`;

export async function listOutboundStatuses(db: D1Database, userId: string, capabilities: WorkspaceCapabilities) {
  if (!capabilities.outboundStatuses) return { results: [] as WorkspaceOutboundStatusRow[] };
  if (!capabilities.outboundReceipts) return db.prepare(`
    SELECT message_id, status, attempts, delivered_at, last_error, provider_message_id,
      provider, NULL AS result_kind, NULL AS remote_status, '' AS response_preview, last_event, last_event_at
    FROM workspace_delivery_statuses WHERE user_id = ?
  `).bind(userId).all<WorkspaceOutboundStatusRow>();
  return db.prepare(`
    SELECT s.message_id, s.status, s.attempts, s.delivered_at, s.last_error, s.provider_message_id,
      COALESCE(r.provider, s.provider) AS provider, r.result_kind, r.remote_status, r.response_preview,
      COALESCE(r.last_event, s.last_event) AS last_event, COALESCE(r.last_event_at, s.last_event_at) AS last_event_at
    FROM workspace_delivery_statuses AS s LEFT JOIN workspace_outbound_receipts AS r
      ON r.message_id = s.message_id AND r.user_id = s.user_id WHERE s.user_id = ?
  `).bind(userId).all<WorkspaceOutboundStatusRow>();
}

export async function findDeliveryDetailRows(db: D1Database, userId: string, messageId: string) {
  const status = db.prepare(`
    WITH target(user_id, message_id) AS (VALUES (?, ?))
    SELECT s.status, r.message_id AS receipt_id, r.provider, r.result_kind, r.remote_status,
      r.response_preview, r.last_event, r.last_event_at
    FROM target
    LEFT JOIN workspace_delivery_statuses s ON s.user_id = target.user_id AND s.message_id = target.message_id
    LEFT JOIN workspace_outbound_receipts r ON r.user_id = target.user_id AND r.message_id = target.message_id
  `).bind(userId, messageId);
  const events = db.prepare(`
    SELECT svix_id, provider_message_id, event_type, event_created_at, summary,
      CASE WHEN ${wasDeferred} THEN json_remove(payload_json, '${deferredPath}') ELSE payload_json END AS payload_json
    FROM workspace_outbound_events WHERE user_id = ? AND message_id = ? ORDER BY event_created_at DESC, created_at DESC
  `).bind(userId, messageId);
  const [record, history, incident] = await db.batch([status, events, currentDeliveryAttentionStatement(db, userId, messageId)]);
  const row = record.results[0] as (WorkspaceOutboundReceiptRow & { status: DeliveryStatus | null; receipt_id: string | null }) | undefined;
  return {
    receipt: row?.receipt_id ? row : null,
    status: row?.status ?? null,
    events: history.results as WorkspaceOutboundEventRow[],
    attention: (incident.results[0] as DeliveryAttentionItem | undefined) ?? null
  };
}

export interface DeliveryStatusPayload {
  messageId: string; userId: string; status: DeliveryStatus; attempts: number; deliveredAt: string | null;
  lastError: string; providerMessageId: string | null; idempotencyKey: string; provider: string;
  submittedAt: string | null; sentAt: string | null; lastEvent: DeliveryEventType; lastEventAt: string;
  createdAt: string; updatedAt: string;
}
export interface DeliveryReceiptPayload {
  messageId: string; userId: string; provider: string; resultKind: DeliveryResultKind | null; remoteStatus: number | null;
  responsePreview: string; lastEvent: DeliveryEventType; lastEventAt: string; createdAt: string; updatedAt: string;
}
export interface DeliveryEventPayload {
  svixId: string; messageId: string; userId: string; provider: string; providerMessageId?: string | null;
  eventType: DeliveryEventType; eventCreatedAt: string; summary: string; payloadJson: string; createdAt: string;
}

export function insertOutboundStatus(db: D1Database, p: DeliveryStatusPayload) {
  return db.prepare(`INSERT INTO workspace_delivery_statuses
    (message_id, user_id, status, attempts, idempotency_key, provider, provider_message_id, last_error,
      submitted_at, sent_at, delivered_at, last_event, last_event_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(p.messageId, p.userId, p.status, p.attempts, p.idempotencyKey, p.provider, p.providerMessageId,
      p.lastError, p.submittedAt, p.sentAt, p.deliveredAt, p.lastEvent, p.lastEventAt, p.createdAt, p.updatedAt);
}
export function claimOutboundRetry(db: D1Database, p: DeliveryStatusPayload) {
  return db.prepare(`
    UPDATE workspace_delivery_statuses AS delivery
    SET status = 'submitting', attempts = ?, provider = ?, last_error = '',
      last_event = 'submission', last_event_at = ?, updated_at = ?
    WHERE message_id = ? AND user_id = ? AND attempts = ? AND idempotency_key = ?
      AND status IN ('submitting', 'delayed', 'failed') AND last_event IS NOT 'email.failed'
      AND NOT EXISTS (
        SELECT 1 FROM workspace_outbound_receipts receipt
        WHERE receipt.message_id = delivery.message_id AND receipt.user_id = delivery.user_id
          AND receipt.result_kind NOT IN ('temporary_failure', 'permanent_failure', 'rate_limited')
      )
  `).bind(p.attempts, p.provider, p.lastEventAt, p.updatedAt, p.messageId, p.userId, p.attempts - 1, p.idempotencyKey);
}

export function upsertOutboundStatus(db: D1Database, p: DeliveryStatusPayload) {
  return db.prepare(`
    INSERT INTO workspace_delivery_statuses
      (message_id, user_id, status, attempts, idempotency_key, provider, provider_message_id, last_error,
        submitted_at, sent_at, delivered_at, last_event, last_event_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET status = excluded.status, attempts = excluded.attempts,
      idempotency_key = COALESCE(workspace_delivery_statuses.idempotency_key, excluded.idempotency_key), provider = excluded.provider,
      provider_message_id = COALESCE(excluded.provider_message_id, workspace_delivery_statuses.provider_message_id),
      last_error = excluded.last_error,
      submitted_at = COALESCE(excluded.submitted_at, workspace_delivery_statuses.submitted_at),
      sent_at = COALESCE(excluded.sent_at, workspace_delivery_statuses.sent_at),
      delivered_at = CASE
        WHEN excluded.provider_message_id IS NOT NULL AND excluded.provider_message_id IS NOT workspace_delivery_statuses.provider_message_id
        THEN excluded.delivered_at ELSE COALESCE(excluded.delivered_at, workspace_delivery_statuses.delivered_at) END,
      last_event = excluded.last_event, last_event_at = excluded.last_event_at, updated_at = excluded.updated_at
    WHERE workspace_delivery_statuses.status NOT IN (${terminalStatuses})
      OR COALESCE(workspace_delivery_statuses.last_event, '') NOT GLOB 'email.*'
      OR (excluded.provider_message_id IS NOT NULL AND excluded.provider_message_id IS NOT workspace_delivery_statuses.provider_message_id)
  `).bind(p.messageId, p.userId, p.status, p.attempts, p.idempotencyKey, p.provider, p.providerMessageId,
    p.lastError, p.submittedAt, p.sentAt, p.deliveredAt, p.lastEvent, p.lastEventAt, p.createdAt, p.updatedAt);
}

export interface DeliveryAttemptPayload {
  id: string; messageId: string; userId: string; attemptNumber: number; idempotencyKey: string;
  provider: string; providerMessageId: string | null; status: DeliveryStatus; error: string | null;
  startedAt: string; completedAt: string | null; createdAt: string;
}

// The delivery-status claim immediately precedes this insert in the same D1 batch.
export function insertDeliveryAttempt(db: D1Database, p: DeliveryAttemptPayload) {
  return db.prepare(`INSERT INTO workspace_delivery_attempts
    (id, message_id, user_id, attempt_number, idempotency_key, provider, provider_message_id, status,
      error, started_at, completed_at, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`)
    .bind(p.id, p.messageId, p.userId, p.attemptNumber, p.idempotencyKey, p.provider,
      p.providerMessageId, p.status, p.error, p.startedAt, p.completedAt, p.createdAt);
}

export function finishDeliveryAttempt(db: D1Database, p: Pick<DeliveryAttemptPayload, 'messageId' | 'attemptNumber' | 'providerMessageId' | 'status' | 'error' | 'completedAt'>) {
  return db.prepare(`UPDATE workspace_delivery_attempts SET provider_message_id = ?, status = ?, error = ?, completed_at = ?
    WHERE message_id = ? AND attempt_number = ?`)
    .bind(p.providerMessageId, p.status, p.error, p.completedAt, p.messageId, p.attemptNumber);
}

export async function findDeliveryStatus(db: D1Database, userId: string, messageId: string) {
  return db.prepare(`SELECT s.message_id, s.user_id, s.status, s.attempts, s.idempotency_key, s.provider,
    s.provider_message_id, s.last_error, s.submitted_at, s.sent_at, s.delivered_at, s.last_event, s.last_event_at,
    r.result_kind, r.remote_status, r.response_preview,
    (SELECT MAX(started_at) FROM workspace_delivery_attempts AS a WHERE a.message_id = s.message_id) AS attempt_started_at
    FROM workspace_delivery_statuses AS s LEFT JOIN workspace_outbound_receipts AS r ON r.message_id = s.message_id AND r.user_id = s.user_id
    WHERE s.user_id = ? AND s.message_id = ?`)
    .bind(userId, messageId).first<{
      message_id: string; user_id: string; status: DeliveryStatus; attempts: number; idempotency_key: string;
      provider: string; provider_message_id: string | null; last_error: string; submitted_at: string | null;
      sent_at: string | null; delivered_at: string | null; last_event: DeliveryEventType | null; last_event_at: string | null;
      result_kind: DeliveryResultKind | null; remote_status: number | null; response_preview: string | null; attempt_started_at: string | null;
    }>();
}
export function upsertOutboundReceipt(db: D1Database, p: DeliveryReceiptPayload) {
  return db.prepare(`
    INSERT INTO workspace_outbound_receipts (message_id, user_id, provider, result_kind, remote_status, response_preview, last_event, last_event_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET provider = excluded.provider, result_kind = excluded.result_kind, remote_status = excluded.remote_status,
      response_preview = excluded.response_preview, last_event = excluded.last_event, last_event_at = excluded.last_event_at, updated_at = excluded.updated_at
    WHERE NOT EXISTS (
      SELECT 1 FROM workspace_delivery_statuses s
      WHERE s.message_id = excluded.message_id AND s.user_id = excluded.user_id
        AND s.status IN (${terminalStatuses}) AND s.last_event GLOB 'email.*'
    )
  `).bind(p.messageId, p.userId, p.provider, p.resultKind, p.remoteStatus, p.responsePreview, p.lastEvent, p.lastEventAt, p.createdAt, p.updatedAt);
}

export function updateOutboundReceiptForCurrentEvent(db: D1Database, p: DeliveryReceiptPayload & { providerMessageId: string; claim?: DeferredEventClaim }) {
  const guard = replayGuard(p.claim);
  return db.prepare(`
    UPDATE workspace_outbound_receipts SET provider = ?, result_kind = ?, remote_status = ?, response_preview = ?,
      last_event = ?, last_event_at = ?, updated_at = ?
    WHERE message_id = ? AND user_id = ? AND EXISTS (
      SELECT 1 FROM workspace_delivery_statuses AS s
      WHERE s.message_id = workspace_outbound_receipts.message_id
        AND s.user_id = workspace_outbound_receipts.user_id
        AND s.provider_message_id = ?
        AND s.last_event = ? AND s.last_event_at = ?
    ) ${guard.sql}
  `).bind(p.provider, p.resultKind, p.remoteStatus, p.responsePreview, p.lastEvent, p.lastEventAt,
    p.updatedAt, p.messageId, p.userId, p.providerMessageId, p.lastEvent, p.lastEventAt, ...guard.args);
}

export function reconcileDeliveryStatus(db: D1Database, input: {
  messageId: string;
  targetStatus: DeliveryStatus;
  targetRank: number;
  provider: string;
  providerMessageId: string;
  lastError: string;
  eventType: DeliveryEventType;
  eventCreatedAt: string;
  fromDeferred?: boolean;
  claim?: DeferredEventClaim;
}) {
  const guard = replayGuard(input.claim);
  const terminal = Number(isDeliveryTerminal(input.targetStatus));
  const currentRank = `CASE status
    WHEN 'draft' THEN 0 WHEN 'queued' THEN 1 WHEN 'submitting' THEN 2 WHEN 'submitted' THEN 3
    WHEN 'sent' THEN 4 WHEN 'delayed' THEN 4 WHEN 'bounced' THEN 5 WHEN 'failed' THEN 5
    WHEN 'complained' THEN 6 WHEN 'suppressed' THEN 6 WHEN 'delivered' THEN 7 ELSE -1 END`;
  return db.prepare(`
    UPDATE workspace_delivery_statuses AS current SET
      status = ?, provider = ?, provider_message_id = ?, last_error = ?,
      sent_at = CASE WHEN ? = 'sent' THEN COALESCE(sent_at, ?) ELSE sent_at END,
      delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
      last_event = ?, last_event_at = ?, updated_at = ?
    WHERE message_id = ? AND provider_message_id = ?
      AND (? OR NOT (${unconfirmedAttempt('current')}))
      AND (? OR NOT EXISTS (
        SELECT 1 FROM workspace_delivery_attempts attempt
        WHERE attempt.message_id = current.message_id AND attempt.attempt_number = current.attempts
          AND julianday(attempt.started_at) > julianday(?)
          AND (? OR EXISTS (
            SELECT 1 FROM workspace_delivery_attempts prior
            WHERE prior.message_id = current.message_id AND prior.attempt_number < attempt.attempt_number
              AND prior.provider_message_id = current.provider_message_id
          ))
          AND NOT (
            ? IN ('sent', 'delayed') AND NOT EXISTS (${newerProviderEvent('current')})
          )
      ))
      AND (last_event IS 'submission' OR status NOT IN (${terminalStatuses}) OR status = ?)
      AND (last_event IS 'submission' OR ? > ${currentRank} OR (? = ${currentRank} AND ? >= COALESCE(last_event_at, '')))
      ${guard.sql}
  `).bind(
    input.targetStatus, input.provider, input.providerMessageId, input.lastError,
    input.targetStatus, input.eventCreatedAt, input.targetStatus, input.eventCreatedAt,
    input.eventType, input.eventCreatedAt, input.eventCreatedAt, input.messageId, input.providerMessageId,
    terminal, terminal, input.eventCreatedAt, Number(input.fromDeferred ?? false),
    input.targetStatus, input.eventCreatedAt,
    input.targetStatus, input.targetRank, input.targetRank, input.eventCreatedAt, ...guard.args
  );
}
export function retainProviderDelayAfterRetry(db: D1Database, messageId: string, providerMessageId: string, eventCreatedAt: string, claim?: DeferredEventClaim) {
  const guard = replayGuard(claim);
  const replacement = `
    SELECT delivery.attempts, original.id AS original_id, retry.id AS retry_id
    FROM workspace_delivery_statuses delivery
    JOIN workspace_delivery_attempts attempt
      ON attempt.message_id = delivery.message_id AND attempt.attempt_number = delivery.attempts
    JOIN workspace_delivery_attention original
      ON original.message_id = delivery.message_id AND original.user_id = delivery.user_id
      AND original.delayed_provider_message_id = delivery.provider_message_id AND original.closed_at IS NULL
      AND original.attempt_number < delivery.attempts
    LEFT JOIN workspace_delivery_attention retry
      ON retry.message_id = delivery.message_id AND retry.user_id = delivery.user_id
      AND retry.attempt_number > original.attempt_number AND retry.delayed_provider_message_id IS NULL
      AND retry.kind IN ('delayed', 'failed', 'stale_submitting') AND retry.closed_at IS NULL
      AND retry.eligible_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE delivery.message_id = ? AND delivery.provider_message_id = ?
      AND NOT (${unconfirmedAttempt('delivery')})
      AND (delivery.last_event IS 'submission'
        OR (delivery.status IN ('sent', 'delayed') AND julianday(delivery.last_event_at) <= julianday(?)))
      AND (
        julianday(?) < julianday(attempt.started_at)
        OR (delivery.last_event IS 'submission' AND attempt.provider_message_id IS NULL
          AND (attempt.completed_at IS NOT NULL OR attempt.error IS NOT NULL))
      )
      AND (julianday(?) >= julianday(attempt.started_at) OR NOT EXISTS (${newerProviderEvent('delivery')}))
    ${guard.sql}
    ORDER BY original.attempt_number DESC, retry.attempt_number DESC LIMIT 1`;
  const args = [messageId, providerMessageId, eventCreatedAt, eventCreatedAt, eventCreatedAt, eventCreatedAt, ...guard.args];
  return [
    db.prepare(`
      UPDATE workspace_delivery_attention_clock SET version = version + 1
      WHERE singleton = 1 AND EXISTS (SELECT 1 FROM (${replacement}) WHERE retry_id IS NOT NULL)
    `).bind(...args),
    db.prepare(`
      WITH replacement AS MATERIALIZED (${replacement})
      UPDATE workspace_delivery_attention
      SET attempt_number = CASE WHEN id = replacement.original_id THEN replacement.attempts ELSE attempt_number END,
        version = CASE WHEN id = replacement.original_id AND replacement.retry_id IS NOT NULL THEN (SELECT version FROM workspace_delivery_attention_clock) ELSE version END,
        state = CASE WHEN id = replacement.retry_id THEN 'superseded' ELSE state END,
        closed_at = CASE WHEN id = replacement.retry_id THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE closed_at END
      FROM replacement WHERE id IN (replacement.original_id, replacement.retry_id)
    `).bind(...args)
  ];
}

export function supersedeLocalSubmissionFailure(db: D1Database, messageId: string, providerMessageId: string, claim?: DeferredEventClaim) {
  const guard = replayGuard(claim);
  return db.prepare(`
    UPDATE workspace_delivery_attention AS attention
    SET state = 'superseded', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE message_id = ? AND closed_at IS NULL AND EXISTS (
      SELECT 1 FROM workspace_delivery_statuses delivery
      WHERE delivery.message_id = attention.message_id AND delivery.user_id = attention.user_id
        AND delivery.provider_message_id = ? AND delivery.status = 'failed' AND delivery.last_event = 'submission'
    ) ${guard.sql}
  `).bind(messageId, providerMessageId, ...guard.args);
}

export function ensureProviderFailureAttention(db: D1Database, messageId: string, providerMessageId: string, eventCreatedAt: string, claim?: DeferredEventClaim) {
  const guard = replayGuard(claim);
  return db.prepare(`
    INSERT INTO workspace_delivery_attention (user_id, message_id, attempt_number, kind, eligible_at)
    SELECT source.user_id, source.message_id, source.attempt_number, source.kind, source.eligible_at
    FROM workspace_delivery_attention_source source
    JOIN workspace_delivery_statuses delivery ON delivery.message_id = source.message_id AND delivery.user_id = source.user_id
    WHERE source.message_id = ? AND source.kind = 'failed' AND source.eligible_at IS NOT NULL
      AND delivery.provider_message_id = ? AND delivery.last_event = 'email.failed' AND delivery.last_event_at = ?
      AND NOT EXISTS (
        SELECT 1 FROM workspace_delivery_attention current
        WHERE current.message_id = source.message_id AND current.user_id = source.user_id
          AND current.kind = 'failed' AND current.attempt_number = source.attempt_number AND current.closed_at IS NULL
      ) ${guard.sql}
  `).bind(messageId, providerMessageId, eventCreatedAt, ...guard.args);
}

export function resolveLocalDelayOnSent(db: D1Database, messageId: string, providerMessageId: string, eventCreatedAt: string, claim?: DeferredEventClaim) {
  const guard = replayGuard(claim);
  return db.prepare(`
    UPDATE workspace_delivery_attention AS attention
    SET state = 'resolved', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE message_id = ? AND kind = 'delayed' AND closed_at IS NULL AND delayed_provider_message_id IS NULL
      AND EXISTS (
        SELECT 1 FROM workspace_delivery_statuses delivery
        WHERE delivery.message_id = attention.message_id AND delivery.user_id = attention.user_id
          AND delivery.provider_message_id = ? AND delivery.last_event = 'email.sent' AND delivery.last_event_at = ?
      ) ${guard.sql}
  `).bind(messageId, providerMessageId, eventCreatedAt, ...guard.args);
}

export function insertOutboundEvent(db: D1Database, p: DeliveryEventPayload) {
  return db.prepare(`INSERT INTO workspace_outbound_events (svix_id, message_id, user_id, provider, provider_message_id, event_type, event_created_at, summary, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(p.svixId, p.messageId, p.userId, p.provider, p.providerMessageId ?? null, p.eventType, p.eventCreatedAt, p.summary, p.payloadJson, p.createdAt);
}
export function deleteOutboundStatus(db: D1Database, userId: string, messageId: string) {
  return db.prepare(`DELETE FROM workspace_delivery_statuses WHERE user_id = ? AND message_id = ?`).bind(userId, messageId);
}
export async function findOutboundByProviderMessageId(db: D1Database, providerMessageId: string) {
  return db.prepare(`
    SELECT s.message_id, s.user_id, s.status, s.attempts, s.idempotency_key, s.provider,
      s.provider_message_id, s.last_error, s.submitted_at, s.sent_at, s.delivered_at,
      s.last_event, s.last_event_at, r.result_kind, r.remote_status, r.response_preview
    FROM workspace_delivery_statuses AS s LEFT JOIN workspace_outbound_receipts AS r ON r.message_id = s.message_id AND r.user_id = s.user_id
    WHERE s.provider_message_id = ?
  `).bind(providerMessageId).first<{
    message_id: string; user_id: string; status: DeliveryStatus; attempts: number; idempotency_key: string;
    provider: string | null; provider_message_id: string | null; last_error: string; submitted_at: string | null;
    sent_at: string | null; delivered_at: string | null; last_event: DeliveryEventType | null; last_event_at: string | null;
    result_kind: DeliveryResultKind | null; remote_status: number | null; response_preview: string | null;
  }>();
}
export async function hasOutboundEvent(db: D1Database, svixId: string) {
  return Boolean(await db.prepare(`SELECT svix_id FROM workspace_outbound_events WHERE svix_id = ?`).bind(svixId).first<{ svix_id: string }>());
}

export function markDeferredOutboundEvent(db: D1Database, svixId: string) {
  return db.prepare(`UPDATE workspace_outbound_events
    SET payload_json = json_set(payload_json, '${deferredPath}', 1)
    WHERE svix_id = ? AND EXISTS (
      SELECT 1 FROM workspace_delivery_statuses d
      WHERE d.message_id = workspace_outbound_events.message_id AND d.user_id = workspace_outbound_events.user_id
        AND d.provider_message_id = workspace_outbound_events.provider_message_id AND ${unconfirmedAttempt('d')}
    )`).bind(svixId);
}

export function listReadyDeferredProviderIds(db: D1Database) {
  return db.prepare(`
    SELECT delivery.provider_message_id AS id
    FROM workspace_delivery_statuses delivery
    JOIN workspace_outbound_events AS event INDEXED BY idx_workspace_outbound_events_pending_resend
      ON event.provider_message_id = delivery.provider_message_id
    WHERE event.provider = 'resend' AND event.provider_message_id IS NOT NULL
      AND (event.user_id = 'unmatched' OR ${wasDeferred})
      AND (event.user_id = 'unmatched' OR (event.user_id = delivery.user_id AND event.message_id = delivery.message_id))
      AND NOT (${unconfirmedAttempt('delivery')})
    GROUP BY delivery.provider_message_id
    ORDER BY MIN(event.event_created_at)
    LIMIT 10
  `).all<{ id: string }>();
}

export async function listPendingOutboundEvents(db: D1Database, providerMessageId: string, limit: number) {
  return db.prepare(`SELECT svix_id, provider_message_id, event_type, event_created_at, summary, payload_json,
    ${wasDeferred} AS was_deferred
    FROM workspace_outbound_events
    WHERE provider_message_id = ? AND (user_id = 'unmatched' OR (${wasDeferred}))
    ORDER BY event_created_at ASC, created_at ASC, rowid ASC LIMIT ?`)
    .bind(providerMessageId, limit).all<WorkspaceOutboundEventRow & { was_deferred: number }>();
}

export function assignOutboundEvent(db: D1Database, claim: DeferredEventClaim, messageId: string, userId: string, allowUnconfirmed: boolean) {
  return db.prepare(`UPDATE workspace_outbound_events
    SET message_id = ?, user_id = ?, payload_json = json_set(json_remove(payload_json, '${deferredPath}'), '${claimPath}', ?)
    WHERE svix_id = ? AND (user_id = 'unmatched'
      OR (user_id = ? AND message_id = ? AND (${wasDeferred}))) AND EXISTS (
      SELECT 1 FROM workspace_delivery_statuses d
      WHERE d.message_id = ? AND d.user_id = ? AND d.provider_message_id = workspace_outbound_events.provider_message_id
        AND (? OR NOT (${unconfirmedAttempt('d')}))
    )`).bind(messageId, userId, claim.token, claim.svixId, userId, messageId, messageId, userId, Number(allowUnconfirmed));
}

export function finishOutboundEventReplay(db: D1Database, claim: DeferredEventClaim) {
  const guard = replayGuard(claim);
  return db.prepare(`UPDATE workspace_outbound_events SET payload_json = json_remove(payload_json, '${claimPath}')
    WHERE svix_id = ? ${guard.sql}`).bind(claim.svixId, ...guard.args);
}
