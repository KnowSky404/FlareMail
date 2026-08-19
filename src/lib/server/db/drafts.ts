import type { WorkspaceDraftRow } from '$lib/server/workspace/shared';

export async function listDrafts(db: D1Database, userId: string) {
  return db.prepare(`
    SELECT id, to_email, cc, to_json, cc_json, bcc_json, subject, body, is_starred, created_at, updated_at,
      message_id, in_reply_to, "references", thread_key, idempotency_key
    FROM workspace_drafts WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC
  `).bind(userId).all<WorkspaceDraftRow>();
}

export async function findOwnedDraft(db: D1Database, userId: string, draftId: string) {
  return db.prepare(`
    SELECT id, to_email, cc, to_json, cc_json, bcc_json, subject, body, is_starred, created_at, updated_at,
      message_id, in_reply_to, "references", thread_key, idempotency_key
    FROM workspace_drafts WHERE user_id = ? AND id = ?
  `).bind(userId, draftId).first<WorkspaceDraftRow>();
}

export function insertDraft(db: D1Database, payload: {
  id: string; userId: string; toEmail: string; cc: string; toJson: string; ccJson: string; bccJson: string; subject: string; body: string; isStarred: number;
  messageId: string | null; inReplyTo: string | null; references: string | null; threadKey: string | null;
  idempotencyKey: string; createdAt: string; updatedAt: string;
}) {
  return db.prepare(`
    INSERT INTO workspace_drafts (id, user_id, to_email, cc, to_json, cc_json, bcc_json, subject, body, is_starred, message_id, in_reply_to, "references", thread_key, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(payload.id, payload.userId, payload.toEmail, payload.cc, payload.toJson, payload.ccJson, payload.bccJson, payload.subject, payload.body, payload.isStarred,
    payload.messageId, payload.inReplyTo, payload.references, payload.threadKey, payload.idempotencyKey, payload.createdAt, payload.updatedAt);
}

export function updateDraftIfVersion(db: D1Database, payload: {
  id: string; userId: string; expectedUpdatedAt: string; toEmail: string; cc: string; toJson: string; ccJson: string; bccJson: string; subject: string; body: string;
  isStarred: number; messageId: string | null; inReplyTo: string | null; references: string | null; threadKey: string | null;
  idempotencyKey: string; updatedAt: string;
}) {
  return db.prepare(`
    UPDATE workspace_drafts SET to_email = ?, cc = ?, to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, body = ?, is_starred = ?, message_id = ?,
      in_reply_to = ?, "references" = ?, thread_key = ?, idempotency_key = ?, updated_at = ?
    WHERE user_id = ? AND id = ? AND updated_at = ?
  `).bind(payload.toEmail, payload.cc, payload.toJson, payload.ccJson, payload.bccJson, payload.subject, payload.body, payload.isStarred, payload.messageId,
    payload.inReplyTo, payload.references, payload.threadKey, payload.idempotencyKey, payload.updatedAt,
    payload.userId, payload.id, payload.expectedUpdatedAt);
}

export function overwriteDraft(db: D1Database, payload: Omit<Parameters<typeof updateDraftIfVersion>[1], 'expectedUpdatedAt'>) {
  return db.prepare(`
    UPDATE workspace_drafts SET to_email = ?, cc = ?, to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, body = ?, is_starred = ?, message_id = ?,
      in_reply_to = ?, "references" = ?, thread_key = ?, idempotency_key = ?, updated_at = ?
    WHERE user_id = ? AND id = ?
  `).bind(payload.toEmail, payload.cc, payload.toJson, payload.ccJson, payload.bccJson, payload.subject, payload.body, payload.isStarred, payload.messageId,
    payload.inReplyTo, payload.references, payload.threadKey, payload.idempotencyKey, payload.updatedAt, payload.userId, payload.id);
}

export function upsertDraft(db: D1Database, payload: {
  id: string; userId: string; toEmail: string; cc: string; toJson: string; ccJson: string; bccJson: string; subject: string; body: string; isStarred: number;
  messageId: string | null; inReplyTo: string | null; references: string | null; threadKey: string | null;
  idempotencyKey: string; createdAt: string; updatedAt: string;
}) {
  return db.prepare(`
    INSERT INTO workspace_drafts (id, user_id, to_email, cc, to_json, cc_json, bcc_json, subject, body, is_starred, message_id, in_reply_to, "references", thread_key, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET to_email = excluded.to_email, cc = excluded.cc, to_json = excluded.to_json, cc_json = excluded.cc_json, bcc_json = excluded.bcc_json, subject = excluded.subject,
      body = excluded.body, is_starred = excluded.is_starred, message_id = excluded.message_id,
      in_reply_to = excluded.in_reply_to, "references" = excluded."references", thread_key = excluded.thread_key,
      idempotency_key = excluded.idempotency_key, updated_at = excluded.updated_at
  `).bind(payload.id, payload.userId, payload.toEmail, payload.cc, payload.toJson, payload.ccJson, payload.bccJson, payload.subject, payload.body, payload.isStarred,
    payload.messageId, payload.inReplyTo, payload.references, payload.threadKey, payload.idempotencyKey, payload.createdAt, payload.updatedAt);
}

export function updateDraftStarred(db: D1Database, userId: string, draftId: string, starred: boolean, timestamp: string) {
  return db.prepare(`UPDATE workspace_drafts SET is_starred = ?, updated_at = ? WHERE user_id = ? AND id = ?`)
    .bind(starred ? 1 : 0, timestamp, userId, draftId);
}

export function deleteDraft(db: D1Database, userId: string, draftId: string) {
  return db.prepare(`DELETE FROM workspace_drafts WHERE user_id = ? AND id = ?`).bind(userId, draftId);
}
