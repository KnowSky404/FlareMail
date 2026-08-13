import type { WorkspaceDraftRow } from '$lib/server/workspace/shared';

export async function listDrafts(db: D1Database, userId: string) {
  return db.prepare(`
    SELECT id, to_email, cc, subject, body, is_starred, created_at, updated_at,
      message_id, in_reply_to, "references", thread_key, idempotency_key
    FROM workspace_drafts WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC
  `).bind(userId).all<WorkspaceDraftRow>();
}

export function upsertDraft(db: D1Database, payload: {
  id: string; userId: string; toEmail: string; cc: string; subject: string; body: string; isStarred: number;
  messageId: string | null; inReplyTo: string | null; references: string | null; threadKey: string | null;
  idempotencyKey: string; createdAt: string; updatedAt: string;
}) {
  return db.prepare(`
    INSERT INTO workspace_drafts (id, user_id, to_email, cc, subject, body, is_starred, message_id, in_reply_to, "references", thread_key, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET to_email = excluded.to_email, cc = excluded.cc, subject = excluded.subject,
      body = excluded.body, is_starred = excluded.is_starred, message_id = excluded.message_id,
      in_reply_to = excluded.in_reply_to, "references" = excluded."references", thread_key = excluded.thread_key,
      idempotency_key = excluded.idempotency_key, updated_at = excluded.updated_at
  `).bind(payload.id, payload.userId, payload.toEmail, payload.cc, payload.subject, payload.body, payload.isStarred,
    payload.messageId, payload.inReplyTo, payload.references, payload.threadKey, payload.idempotencyKey, payload.createdAt, payload.updatedAt);
}

export function updateDraftStarred(db: D1Database, userId: string, draftId: string, starred: boolean, timestamp: string) {
  return db.prepare(`UPDATE workspace_drafts SET is_starred = ?, updated_at = ? WHERE user_id = ? AND id = ?`)
    .bind(starred ? 1 : 0, timestamp, userId, draftId);
}

export function deleteDraft(db: D1Database, userId: string, draftId: string) {
  return db.prepare(`DELETE FROM workspace_drafts WHERE user_id = ? AND id = ?`).bind(userId, draftId);
}
