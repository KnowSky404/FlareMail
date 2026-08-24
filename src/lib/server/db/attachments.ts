export type AttachmentRelationType = 'inbound' | 'draft' | 'message';
export type AttachmentState = 'uploading' | 'ready' | 'failed' | 'delete_pending';
export type AttachmentDisposition = 'attachment' | 'inline';

export interface StoredAttachmentRow {
  id: string;
  user_id: string;
  message_id: string;
  filename: string;
  content_type: string;
  size: number;
  inline: number;
  content_id: string | null;
  r2_key: string;
  relation_type: AttachmentRelationType;
  state: AttachmentState;
  sha256: string | null;
  disposition: AttachmentDisposition;
  created_at: string;
  updated_at: string;
  delete_after: string | null;
}

export interface AttachmentInsert {
  id: string;
  userId: string;
  messageId: string;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
  contentId: string | null;
  r2Key: string;
  sha256?: string | null;
  disposition?: AttachmentDisposition;
}

export interface DraftAttachmentInsert {
  id: string;
  userId: string;
  draftId: string;
  filename: string;
  contentType: string;
  size: number;
  r2Key: string;
  contentId?: string | null;
  disposition?: AttachmentDisposition;
  createdAt?: string;
  deleteAfter?: string | null;
  expectedRevision?: number;
}

const attachmentColumns = `
  id, user_id, message_id, filename, content_type, size, inline, content_id, r2_key,
  relation_type, state, sha256, disposition, created_at, updated_at, delete_after
`;

/** Insert a parsed inbound attachment while retaining the old API contract. */
export function insertAttachment(db: D1Database, attachment: AttachmentInsert) {
  return db.prepare(`
    INSERT INTO workspace_attachments (
      id, user_id, message_id, filename, content_type, size, inline, content_id, r2_key,
      relation_type, state, sha256, disposition, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbound', 'ready', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).bind(
    attachment.id,
    attachment.userId,
    attachment.messageId,
    attachment.filename,
    attachment.contentType,
    attachment.size,
    attachment.inline ? 1 : 0,
    attachment.contentId,
    attachment.r2Key,
    attachment.sha256 ?? null,
    attachment.disposition ?? (attachment.inline ? 'inline' : 'attachment')
  );
}

/** List legacy/inbound attachments for the existing message detail/download APIs. */
export async function listAttachmentsForMessage(db: D1Database, userId: string, messageId: string) {
  const result = await db.prepare(`
    SELECT ${attachmentColumns}
    FROM workspace_attachments
    WHERE user_id = ? AND message_id = ? AND relation_type IN ('inbound', 'message')
    ORDER BY created_at ASC, id ASC
  `).bind(userId, messageId).all<StoredAttachmentRow>();
  return result.results ?? [];
}

export async function findOwnedAttachment(
  db: D1Database,
  userId: string,
  messageId: string,
  attachmentId: string
) {
  return db.prepare(`
    SELECT a.id, a.user_id, a.message_id, a.filename, a.content_type, a.size, a.inline, a.content_id, a.r2_key,
      a.relation_type, a.state, a.sha256, a.disposition, a.created_at, a.updated_at, a.delete_after
    FROM workspace_attachments AS a
    JOIN email_messages AS e ON e.id = a.message_id
    WHERE a.id = ? AND a.message_id = ? AND a.relation_type = 'inbound'
      AND a.user_id = ? AND e.owner_user_id = ?
    UNION ALL
    SELECT a.id, a.user_id, a.message_id, a.filename, a.content_type, a.size, a.inline, a.content_id, a.r2_key,
      a.relation_type, a.state, a.sha256, a.disposition, a.created_at, a.updated_at, a.delete_after
    FROM workspace_attachments AS a
    JOIN workspace_messages AS m ON m.id = a.message_id
    WHERE a.id = ? AND a.message_id = ? AND a.relation_type = 'message'
      AND a.user_id = ? AND m.user_id = ?
  `).bind(attachmentId, messageId, userId, userId, attachmentId, messageId, userId, userId).first<StoredAttachmentRow>();
}

export async function listAttachmentsForEntity(
  db: D1Database,
  userId: string,
  relationType: AttachmentRelationType,
  entityId: string,
  options: { includeNonReady?: boolean } = {}
) {
  const stateFilter = options.includeNonReady ? '' : ` AND state = 'ready'`;
  const result = await db.prepare(`
    SELECT ${attachmentColumns}
    FROM workspace_attachments
    WHERE user_id = ? AND relation_type = ? AND message_id = ?${stateFilter}
    ORDER BY created_at ASC, id ASC
  `).bind(userId, relationType, entityId).all<StoredAttachmentRow>();
  return result.results ?? [];
}

/** Create an R2-backed draft attachment in D1 before the upload begins. */
export function insertDraftAttachment(db: D1Database, attachment: DraftAttachmentInsert) {
  return db.prepare(`
    INSERT INTO workspace_attachments (
      id, user_id, message_id, filename, content_type, size, inline, content_id, r2_key,
      relation_type, state, disposition, created_at, updated_at, delete_after
    )
    SELECT ?, ?, ?, ?, ?, ?, 0, ?, ?, 'draft', 'uploading', ?,
      COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?
    FROM workspace_drafts
    WHERE id = ? AND user_id = ? AND (? IS NULL OR attachment_revision = ?)
  `).bind(
    attachment.id,
    attachment.userId,
    attachment.draftId,
    attachment.filename,
    attachment.contentType,
    attachment.size,
    attachment.contentId ?? null,
    attachment.r2Key,
    attachment.disposition ?? 'attachment',
    attachment.createdAt ?? null,
    attachment.createdAt ?? null,
    attachment.deleteAfter ?? null,
    attachment.draftId,
    attachment.userId,
    attachment.expectedRevision ?? null,
    attachment.expectedRevision ?? null
  );
}

/** Reserve a cancelled attachment ID so a late upload cannot resurrect it. */
export function insertDraftAttachmentCancellation(db: D1Database, attachment: DraftAttachmentInsert) {
  return db.prepare(`
    INSERT INTO workspace_attachments (
      id, user_id, message_id, filename, content_type, size, inline, content_id, r2_key,
      relation_type, state, disposition, created_at, updated_at, delete_after
    )
    SELECT ?, ?, ?, ?, 'application/octet-stream', 0, 0, NULL, ?,
      'draft', 'delete_pending', 'attachment',
      COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?
    FROM workspace_drafts
    WHERE id = ? AND user_id = ? AND attachment_revision = ?
  `).bind(
    attachment.id,
    attachment.userId,
    attachment.draftId,
    attachment.filename,
    attachment.r2Key,
    attachment.createdAt ?? null,
    attachment.createdAt ?? null,
    attachment.deleteAfter ?? null,
    attachment.draftId,
    attachment.userId,
    attachment.expectedRevision ?? null
  );
}

// Names used by draft/outbound callers. The draft-specific input keeps the
// ownership preflight in one place and makes it impossible to insert a row
// for another user's draft accidentally.
export const insertUploadingAttachment = insertDraftAttachment;

/** Replace a failed attempt in place so send preflight never observes a gap. */
export function restartDraftAttachment(db: D1Database, attachment: DraftAttachmentInsert) {
  const expected = attachment.expectedRevision;
  return db.prepare(`
    UPDATE workspace_attachments
    SET filename = ?, content_type = ?, size = ?, content_id = ?, r2_key = ?,
      state = 'uploading', sha256 = NULL, disposition = ?, updated_at = ?, delete_after = ?
    WHERE id = ? AND user_id = ? AND message_id = ? AND relation_type = 'draft' AND state = 'failed'
      AND EXISTS (
        SELECT 1 FROM workspace_drafts
        WHERE id = ? AND user_id = ? AND (? IS NULL OR attachment_revision = ?)
      )
  `).bind(
    attachment.filename,
    attachment.contentType,
    attachment.size,
    attachment.contentId ?? null,
    attachment.r2Key,
    attachment.disposition ?? 'attachment',
    attachment.createdAt ?? new Date().toISOString(),
    attachment.deleteAfter ?? null,
    attachment.id,
    attachment.userId,
    attachment.draftId,
    attachment.draftId,
    attachment.userId,
    expected ?? null,
    expected ?? null
  );
}

export async function listAttachmentsForDraft(db: D1Database, userId: string, draftId: string) {
  const result = await db.prepare(`
    SELECT ${attachmentColumns}
    FROM workspace_attachments
    WHERE user_id = ? AND message_id = ? AND relation_type = 'draft'
    ORDER BY created_at ASC, id ASC
  `).bind(userId, draftId).all<StoredAttachmentRow>();
  return result.results ?? [];
}

export async function findOwnedDraftAttachment(db: D1Database, userId: string, draftId: string, attachmentId: string) {
  return db.prepare(`
    SELECT ${attachmentColumns}
    FROM workspace_attachments
    WHERE id = ? AND user_id = ? AND message_id = ? AND relation_type = 'draft'
  `).bind(attachmentId, userId, draftId).first<StoredAttachmentRow>();
}

/** Mark an upload complete only while the row is still owned by this draft. */
export function markDraftAttachmentReady(db: D1Database, input: {
  userId: string; draftId: string; attachmentId: string; r2Key: string; sha256: string; size: number; updatedAt: string; expectedRevision?: number;
}) {
  const expected = input.expectedRevision;
  return db.prepare(`
    UPDATE workspace_attachments
    SET state = 'ready', sha256 = ?, size = ?, delete_after = NULL, updated_at = ?
    WHERE id = ? AND user_id = ? AND message_id = ? AND r2_key = ? AND relation_type = 'draft'
      AND state IN ('uploading', 'failed')
      AND EXISTS (
        SELECT 1 FROM workspace_drafts
        WHERE id = ? AND user_id = ? AND (? IS NULL OR attachment_revision = ?)
      )
  `).bind(input.sha256, input.size, input.updatedAt, input.attachmentId, input.userId, input.draftId, input.r2Key,
    input.draftId, input.userId, expected ?? null, expected ?? null);
}

export function markAttachmentReady(db: D1Database, input: {
  userId: string; entityId: string; attachmentId: string; r2Key: string; sha256: string; size: number; updatedAt: string; expectedRevision?: number;
}) {
  return markDraftAttachmentReady(db, {
    userId: input.userId, draftId: input.entityId, attachmentId: input.attachmentId,
    r2Key: input.r2Key, sha256: input.sha256, size: input.size, updatedAt: input.updatedAt, expectedRevision: input.expectedRevision
  });
}

export function markDraftAttachmentFailed(db: D1Database, input: {
  userId: string; draftId: string; attachmentId: string; r2Key: string; updatedAt: string; deleteAfter?: string | null; expectedRevision?: number;
}) {
  const expected = input.expectedRevision;
  return db.prepare(`
    UPDATE workspace_attachments
    SET state = 'failed', delete_after = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND message_id = ? AND r2_key = ? AND relation_type = 'draft'
      AND state = 'uploading'
      AND EXISTS (
        SELECT 1 FROM workspace_drafts
        WHERE id = ? AND user_id = ? AND (? IS NULL OR attachment_revision = ?)
      )
  `).bind(input.deleteAfter ?? null, input.updatedAt, input.attachmentId, input.userId, input.draftId, input.r2Key,
    input.draftId, input.userId, expected ?? null, expected ?? null);
}

export function markAttachmentFailed(db: D1Database, input: {
  userId: string; entityId: string; attachmentId: string; r2Key: string; updatedAt: string; deleteAfter?: string | null; expectedRevision?: number;
}) {
  return markDraftAttachmentFailed(db, {
    userId: input.userId, draftId: input.entityId, attachmentId: input.attachmentId,
    r2Key: input.r2Key, updatedAt: input.updatedAt, deleteAfter: input.deleteAfter, expectedRevision: input.expectedRevision
  });
}

export function renameDraftAttachment(db: D1Database, input: {
  userId: string; draftId: string; attachmentId: string; filename: string; updatedAt: string; expectedRevision?: number;
}) {
  const expected = input.expectedRevision;
  return db.prepare(`
    UPDATE workspace_attachments
    SET filename = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND message_id = ? AND relation_type = 'draft'
      AND state <> 'delete_pending'
      AND EXISTS (
        SELECT 1 FROM workspace_drafts
        WHERE id = ? AND user_id = ? AND (? IS NULL OR attachment_revision = ?)
      )
  `).bind(input.filename, input.updatedAt, input.attachmentId, input.userId, input.draftId,
    input.draftId, input.userId, expected ?? null, expected ?? null);
}

export function renameAttachment(db: D1Database, input: {
  userId: string; entityId: string; attachmentId: string; filename: string; updatedAt: string; expectedRevision?: number;
}) {
  return renameDraftAttachment(db, {
    userId: input.userId, draftId: input.entityId, attachmentId: input.attachmentId,
    filename: input.filename, updatedAt: input.updatedAt, expectedRevision: input.expectedRevision
  });
}

export function markDraftAttachmentDeletePending(db: D1Database, input: {
  userId: string; draftId: string; attachmentId: string; deleteAfter: string; updatedAt: string; expectedRevision?: number;
}) {
  const expected = input.expectedRevision;
  return db.prepare(`
    UPDATE workspace_attachments
    SET state = 'delete_pending', delete_after = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND message_id = ? AND relation_type = 'draft'
      AND state <> 'delete_pending'
      AND EXISTS (
        SELECT 1 FROM workspace_drafts
        WHERE id = ? AND user_id = ? AND (? IS NULL OR attachment_revision = ?)
      )
  `).bind(input.deleteAfter, input.updatedAt, input.attachmentId, input.userId, input.draftId,
    input.draftId, input.userId, expected ?? null, expected ?? null);
}

export function markAttachmentDeletePending(db: D1Database, input: {
  userId: string; entityId: string; attachmentId: string; deleteAfter: string; updatedAt: string; expectedRevision?: number;
}) {
  return markDraftAttachmentDeletePending(db, {
    userId: input.userId, draftId: input.entityId, attachmentId: input.attachmentId,
    deleteAfter: input.deleteAfter, updatedAt: input.updatedAt, expectedRevision: input.expectedRevision
  });
}

export function deleteDraftAttachment(db: D1Database, userId: string, draftId: string, attachmentId: string) {
  return db.prepare(`
    DELETE FROM workspace_attachments
    WHERE id = ? AND user_id = ? AND message_id = ? AND relation_type = 'draft'
  `).bind(attachmentId, userId, draftId);
}

export function deleteDraftAttachmentAttempt(
  db: D1Database,
  userId: string,
  draftId: string,
  attachmentId: string,
  r2Key: string
) {
  return db.prepare(`
    DELETE FROM workspace_attachments
    WHERE id = ? AND user_id = ? AND message_id = ? AND r2_key = ? AND relation_type = 'draft'
  `).bind(attachmentId, userId, draftId, r2Key);
}

export function deleteAttachmentRow(db: D1Database, input: {
  userId: string; entityId: string; attachmentId: string; expectedRevision?: number;
}) {
  const expected = input.expectedRevision;
  return db.prepare(`
    DELETE FROM workspace_attachments
    WHERE id = ? AND user_id = ? AND message_id = ? AND relation_type = 'draft'
      AND EXISTS (
        SELECT 1 FROM workspace_drafts
        WHERE id = ? AND user_id = ? AND (? IS NULL OR attachment_revision = ?)
      )
  `).bind(input.attachmentId, input.userId, input.entityId, input.entityId, input.userId, expected ?? null, expected ?? null);
}

/** Transfer only ready draft attachments after the sent message is persisted. */
export function transferDraftAttachments(
  db: D1Database,
  input: { userId: string; draftId: string; messageId: string; updatedAt: string; attachmentIds?: string[]; expectedRevision?: number }
) {
  const ids = input.attachmentIds?.filter(Boolean) ?? [];
  const idCondition = ids.length ? ` AND a.id IN (${ids.map(() => '?').join(', ')})` : '';
  const expected = input.expectedRevision;
  return db.prepare(`
    UPDATE workspace_attachments AS a
    SET relation_type = 'message', message_id = ?, updated_at = ?, delete_after = NULL
    WHERE a.user_id = ? AND a.message_id = ? AND a.relation_type = 'draft' AND a.state = 'ready'
      AND EXISTS (SELECT 1 FROM workspace_messages AS m WHERE m.id = ? AND m.user_id = ?)
      AND EXISTS (
        SELECT 1 FROM workspace_drafts AS d
        WHERE d.id = ? AND d.user_id = ? AND (? IS NULL OR d.attachment_revision = ?)
      )
      ${idCondition}
  `).bind(input.messageId, input.updatedAt, input.userId, input.draftId, input.messageId, input.userId,
    input.draftId, input.userId, expected ?? null, expected ?? null, ...ids);
}

export const transferDraftAttachmentsToMessage = transferDraftAttachments;

/**
 * Fail a D1 batch unless the draft still owns exactly the ready attachment set
 * that the sender verified. Upload reservations do not advance the public
 * revision until they finish, so the in-transaction state check also rejects a
 * newly inserted uploading/failed row that raced with the sender's preflight.
 */
export function assertDraftAttachmentSet(db: D1Database, input: {
  userId: string;
  draftId: string;
  expectedRevision: number;
  attachmentIds: string[];
}) {
  const ids = [...new Set(input.attachmentIds.filter(Boolean))];
  const exactIds = ids.length
    ? `AND NOT EXISTS (
        SELECT 1 FROM workspace_attachments AS unexpected
        WHERE unexpected.user_id = draft.user_id
          AND unexpected.message_id = draft.id
          AND unexpected.relation_type = 'draft'
          AND unexpected.state = 'ready'
          AND unexpected.id NOT IN (${ids.map(() => '?').join(', ')})
      )`
    : '';
  return db.prepare(`
    INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
    SELECT '__draft_attachment_set_guard__', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE NOT EXISTS (
      SELECT 1 FROM workspace_drafts AS draft
      WHERE draft.id = ? AND draft.user_id = ? AND draft.attachment_revision = ?
        AND NOT EXISTS (
          SELECT 1 FROM workspace_attachments AS pending
          WHERE pending.user_id = draft.user_id
            AND pending.message_id = draft.id
            AND pending.relation_type = 'draft'
            AND pending.state IN ('uploading', 'failed')
        )
        AND (
          SELECT COUNT(*) FROM workspace_attachments AS ready
          WHERE ready.user_id = draft.user_id
            AND ready.message_id = draft.id
            AND ready.relation_type = 'draft'
            AND ready.state = 'ready'
        ) = ?
        ${exactIds}
    )
  `).bind(input.draftId, input.userId, input.expectedRevision, ids.length, ...ids);
}

export function bumpDraftAttachmentRevision(db: D1Database, input: {
  userId: string; draftId: string; updatedAt: string; expectedRevision?: number;
}) {
  const expected = input.expectedRevision;
  return db.prepare(`
    UPDATE workspace_drafts
    SET attachment_revision = attachment_revision + 1, updated_at = ?
    WHERE id = ? AND user_id = ? AND (? IS NULL OR attachment_revision = ?)
  `).bind(input.updatedAt, input.draftId, input.userId, expected ?? null, expected ?? null);
}
