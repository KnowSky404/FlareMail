import type { DeliveryEventType, DeliveryResultKind, DeliveryStatus, WorkspaceCapabilities, WorkspaceOutboundEventRow, WorkspaceOutboundReceiptRow, WorkspaceOutboundStatusRow } from '$lib/server/workspace/shared';

export async function listOutboundStatuses(db: D1Database, userId: string, capabilities: WorkspaceCapabilities) {
  if (!capabilities.outboundStatuses) return { results: [] as WorkspaceOutboundStatusRow[] };
  if (!capabilities.outboundReceipts) return db.prepare(`
    SELECT message_id, status, attempts, delivered_at, last_error, provider_message_id,
      NULL AS provider, NULL AS result_kind, NULL AS remote_status, '' AS response_preview, NULL AS last_event, NULL AS last_event_at
    FROM workspace_outbound_statuses WHERE user_id = ?
  `).bind(userId).all<WorkspaceOutboundStatusRow>();
  return db.prepare(`
    SELECT s.message_id, s.status, s.attempts, s.delivered_at, s.last_error, s.provider_message_id,
      r.provider, r.result_kind, r.remote_status, r.response_preview, r.last_event, r.last_event_at
    FROM workspace_outbound_statuses AS s LEFT JOIN workspace_outbound_receipts AS r
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
  lastError: string; providerMessageId: string | null; createdAt: string; updatedAt: string;
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
  return db.prepare(`INSERT INTO workspace_outbound_statuses (message_id, user_id, status, attempts, delivered_at, last_error, provider_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(p.messageId, p.userId, p.status, p.attempts, p.deliveredAt, p.lastError, p.providerMessageId, p.createdAt, p.updatedAt);
}
export function upsertOutboundStatus(db: D1Database, p: DeliveryStatusPayload) {
  return db.prepare(`
    INSERT INTO workspace_outbound_statuses (message_id, user_id, status, attempts, delivered_at, last_error, provider_message_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, delivered_at = excluded.delivered_at,
      last_error = excluded.last_error, provider_message_id = excluded.provider_message_id, updated_at = excluded.updated_at
  `).bind(p.messageId, p.userId, p.status, p.attempts, p.deliveredAt, p.lastError, p.providerMessageId, p.createdAt, p.updatedAt);
}
export function upsertOutboundReceipt(db: D1Database, p: DeliveryReceiptPayload) {
  return db.prepare(`
    INSERT INTO workspace_outbound_receipts (message_id, user_id, provider, result_kind, remote_status, response_preview, last_event, last_event_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET provider = excluded.provider, result_kind = excluded.result_kind, remote_status = excluded.remote_status,
      response_preview = excluded.response_preview, last_event = excluded.last_event, last_event_at = excluded.last_event_at, updated_at = excluded.updated_at
  `).bind(p.messageId, p.userId, p.provider, p.resultKind, p.remoteStatus, p.responsePreview, p.lastEvent, p.lastEventAt, p.createdAt, p.updatedAt);
}
export function insertOutboundEvent(db: D1Database, p: DeliveryEventPayload) {
  return db.prepare(`INSERT INTO workspace_outbound_events (svix_id, message_id, user_id, provider, provider_message_id, event_type, event_created_at, summary, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(p.svixId, p.messageId, p.userId, p.provider, p.providerMessageId, p.eventType, p.eventCreatedAt, p.summary, p.payloadJson, p.createdAt);
}
export function deleteOutboundStatus(db: D1Database, userId: string, messageId: string) {
  return db.prepare(`DELETE FROM workspace_outbound_statuses WHERE user_id = ? AND message_id = ?`).bind(userId, messageId);
}
export async function findOutboundByProviderMessageId(db: D1Database, providerMessageId: string) {
  return db.prepare(`
    SELECT s.message_id, s.user_id, s.attempts, s.delivered_at, r.remote_status, r.last_event_at
    FROM workspace_outbound_statuses AS s LEFT JOIN workspace_outbound_receipts AS r ON r.message_id = s.message_id AND r.user_id = s.user_id
    WHERE s.provider_message_id = ?
  `).bind(providerMessageId).first<{ message_id: string; user_id: string; attempts: number; delivered_at: string | null; remote_status: number | null; last_event_at: string | null }>();
}
export async function hasOutboundEvent(db: D1Database, svixId: string) {
  return Boolean(await db.prepare(`SELECT svix_id FROM workspace_outbound_events WHERE svix_id = ?`).bind(svixId).first<{ svix_id: string }>());
}
