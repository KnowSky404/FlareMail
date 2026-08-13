import type { DeliveryEventType, DeliveryResultKind, DeliveryStatus, WorkspaceCapabilities, WorkspaceOutboundEventRow, WorkspaceOutboundReceiptRow, WorkspaceOutboundStatusRow } from '$lib/server/workspace/shared';

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

export async function findDeliveryDetailRows(db: D1Database, userId: string, messageId: string, capabilities: WorkspaceCapabilities) {
  const receipt = capabilities.outboundReceipts ? await db.prepare(`
    SELECT provider, result_kind, remote_status, response_preview, last_event, last_event_at
    FROM workspace_outbound_receipts WHERE user_id = ? AND message_id = ?
  `).bind(userId, messageId).first<WorkspaceOutboundReceiptRow>() : null;
  const events = capabilities.outboundEvents ? await db.prepare(`
    SELECT svix_id, event_type, event_created_at, summary, payload_json
    FROM workspace_outbound_events WHERE user_id = ? AND message_id = ? ORDER BY event_created_at DESC, created_at DESC
  `).bind(userId, messageId).all<WorkspaceOutboundEventRow>() : { results: [] as WorkspaceOutboundEventRow[] };
  return { receipt, events: events.results ?? [] };
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
      delivered_at = COALESCE(excluded.delivered_at, workspace_delivery_statuses.delivered_at),
      last_event = excluded.last_event, last_event_at = excluded.last_event_at, updated_at = excluded.updated_at
  `).bind(p.messageId, p.userId, p.status, p.attempts, p.idempotencyKey, p.provider, p.providerMessageId,
    p.lastError, p.submittedAt, p.sentAt, p.deliveredAt, p.lastEvent, p.lastEventAt, p.createdAt, p.updatedAt);
}

export interface DeliveryAttemptPayload {
  id: string; messageId: string; userId: string; attemptNumber: number; idempotencyKey: string;
  provider: string; providerMessageId: string | null; status: DeliveryStatus; error: string | null;
  startedAt: string; completedAt: string | null; createdAt: string;
}

export function insertDeliveryAttempt(db: D1Database, p: DeliveryAttemptPayload) {
  return db.prepare(`INSERT INTO workspace_delivery_attempts
    (id, message_id, user_id, attempt_number, idempotency_key, provider, provider_message_id, status,
      error, started_at, completed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(p.id, p.messageId, p.userId, p.attemptNumber, p.idempotencyKey, p.provider,
      p.providerMessageId, p.status, p.error, p.startedAt, p.completedAt, p.createdAt);
}

export function finishDeliveryAttempt(db: D1Database, p: Pick<DeliveryAttemptPayload, 'messageId' | 'attemptNumber' | 'providerMessageId' | 'status' | 'error' | 'completedAt'>) {
  return db.prepare(`UPDATE workspace_delivery_attempts SET provider_message_id = ?, status = ?, error = ?, completed_at = ?
    WHERE message_id = ? AND attempt_number = ?`)
    .bind(p.providerMessageId, p.status, p.error, p.completedAt, p.messageId, p.attemptNumber);
}

export async function findDeliveryStatus(db: D1Database, userId: string, messageId: string) {
  return db.prepare(`SELECT message_id, user_id, status, attempts, idempotency_key, provider,
    provider_message_id, last_error, submitted_at, sent_at, delivered_at, last_event, last_event_at
    FROM workspace_delivery_statuses WHERE user_id = ? AND message_id = ?`)
    .bind(userId, messageId).first<{
      message_id: string; user_id: string; status: DeliveryStatus; attempts: number; idempotency_key: string;
      provider: string; provider_message_id: string | null; last_error: string; submitted_at: string | null;
      sent_at: string | null; delivered_at: string | null; last_event: DeliveryEventType | null; last_event_at: string | null;
    }>();
}
export function upsertOutboundReceipt(db: D1Database, p: DeliveryReceiptPayload) {
  return db.prepare(`
    INSERT INTO workspace_outbound_receipts (message_id, user_id, provider, result_kind, remote_status, response_preview, last_event, last_event_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET provider = excluded.provider, result_kind = excluded.result_kind, remote_status = excluded.remote_status,
      response_preview = excluded.response_preview, last_event = excluded.last_event, last_event_at = excluded.last_event_at, updated_at = excluded.updated_at
  `).bind(p.messageId, p.userId, p.provider, p.resultKind, p.remoteStatus, p.responsePreview, p.lastEvent, p.lastEventAt, p.createdAt, p.updatedAt);
}

export function updateOutboundReceiptForCurrentEvent(db: D1Database, p: DeliveryReceiptPayload) {
  return db.prepare(`
    UPDATE workspace_outbound_receipts SET provider = ?, result_kind = ?, remote_status = ?, response_preview = ?,
      last_event = ?, last_event_at = ?, updated_at = ?
    WHERE message_id = ? AND user_id = ? AND EXISTS (
      SELECT 1 FROM workspace_delivery_statuses AS s
      WHERE s.message_id = workspace_outbound_receipts.message_id
        AND s.user_id = workspace_outbound_receipts.user_id
        AND s.last_event = ? AND s.last_event_at = ?
    )
  `).bind(p.provider, p.resultKind, p.remoteStatus, p.responsePreview, p.lastEvent, p.lastEventAt,
    p.updatedAt, p.messageId, p.userId, p.lastEvent, p.lastEventAt);
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
}) {
  const currentRank = `CASE status
    WHEN 'draft' THEN 0 WHEN 'queued' THEN 1 WHEN 'submitting' THEN 2 WHEN 'submitted' THEN 3
    WHEN 'sent' THEN 4 WHEN 'delayed' THEN 4 WHEN 'bounced' THEN 5 WHEN 'failed' THEN 5
    WHEN 'complained' THEN 6 WHEN 'suppressed' THEN 6 WHEN 'delivered' THEN 7 ELSE -1 END`;
  return db.prepare(`
    UPDATE workspace_delivery_statuses SET
      status = ?, provider = ?, provider_message_id = ?, last_error = ?,
      sent_at = CASE WHEN ? = 'sent' THEN COALESCE(sent_at, ?) ELSE sent_at END,
      delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
      last_event = ?, last_event_at = ?, updated_at = ?
    WHERE message_id = ?
      AND (status NOT IN ('delivered', 'bounced', 'failed', 'complained', 'suppressed') OR status = ?)
      AND (? > ${currentRank} OR (? = ${currentRank} AND ? >= COALESCE(last_event_at, '')))
  `).bind(
    input.targetStatus, input.provider, input.providerMessageId, input.lastError,
    input.targetStatus, input.eventCreatedAt, input.targetStatus, input.eventCreatedAt,
    input.eventType, input.eventCreatedAt, input.eventCreatedAt, input.messageId,
    input.targetStatus, input.targetRank, input.targetRank, input.eventCreatedAt
  );
}
export function insertOutboundEvent(db: D1Database, p: DeliveryEventPayload) {
  return db.prepare(`INSERT INTO workspace_outbound_events (svix_id, message_id, user_id, provider, provider_message_id, event_type, event_created_at, summary, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(p.svixId, p.messageId, p.userId, p.provider, p.providerMessageId, p.eventType, p.eventCreatedAt, p.summary, p.payloadJson, p.createdAt);
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

export async function listUnmatchedOutboundEvents(db: D1Database, providerMessageId: string) {
  return db.prepare(`SELECT svix_id, event_type, event_created_at, summary, payload_json
    FROM workspace_outbound_events
    WHERE user_id = 'unmatched' AND provider_message_id = ?
    ORDER BY event_created_at ASC, created_at ASC`)
    .bind(providerMessageId).all<WorkspaceOutboundEventRow>();
}

export function assignOutboundEvent(db: D1Database, svixId: string, messageId: string, userId: string) {
  return db.prepare(`UPDATE workspace_outbound_events SET message_id = ?, user_id = ?
    WHERE svix_id = ? AND user_id = 'unmatched'`).bind(messageId, userId, svixId);
}
