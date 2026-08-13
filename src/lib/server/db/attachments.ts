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
}

export function insertAttachment(db: D1Database, attachment: AttachmentInsert) {
  return db.prepare(`
    INSERT INTO workspace_attachments (
      id, user_id, message_id, filename, content_type, size, inline, content_id, r2_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    attachment.id,
    attachment.userId,
    attachment.messageId,
    attachment.filename,
    attachment.contentType,
    attachment.size,
    attachment.inline ? 1 : 0,
    attachment.contentId,
    attachment.r2Key
  );
}

export async function listAttachmentsForMessage(db: D1Database, messageId: string) {
  const result = await db.prepare(`
    SELECT id, user_id, message_id, filename, content_type, size, inline, content_id, r2_key
    FROM workspace_attachments
    WHERE message_id = ?
    ORDER BY created_at ASC, id ASC
  `).bind(messageId).all<StoredAttachmentRow>();
  return result.results ?? [];
}

export async function findOwnedAttachment(
  db: D1Database,
  userId: string,
  messageId: string,
  attachmentId: string
) {
  return db.prepare(`
    SELECT a.id, a.user_id, a.message_id, a.filename, a.content_type, a.size, a.inline, a.content_id, a.r2_key
    FROM workspace_attachments AS a
    JOIN email_messages AS e ON e.id = a.message_id
    WHERE a.id = ? AND a.message_id = ?
      AND a.user_id = ? AND e.owner_user_id = ?
  `).bind(attachmentId, messageId, userId, userId).first<StoredAttachmentRow>();
}
