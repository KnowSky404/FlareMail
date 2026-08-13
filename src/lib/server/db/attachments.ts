/**
 * Repository contract reserved for the versioned attachment schema introduced
 * by the inbound hardening migration. Stage 3 defines ownership without
 * pretending the legacy schema can already persist attachment metadata.
 */
export interface StoredAttachmentRow {
  id: string;
  message_id: string;
  filename: string;
  content_type: string;
  size: number;
  inline: number;
  content_id: string | null;
  r2_key: string;
}

export interface AttachmentRepository {
  listForMessage(userId: string, messageId: string): Promise<StoredAttachmentRow[]>;
  findOwned(userId: string, messageId: string, attachmentId: string): Promise<StoredAttachmentRow | null>;
}
