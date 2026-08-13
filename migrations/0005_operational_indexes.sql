-- Cursor pagination and bounded maintenance scans used by mailbox/session jobs.

CREATE INDEX IF NOT EXISTS idx_email_messages_recipient_cursor
  ON email_messages("to", "timestamp" DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_messages_user_folder_cursor
  ON workspace_messages(user_id, folder, sent_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_sessions_cleanup
  ON workspace_sessions(revoked_at, expires_at);
