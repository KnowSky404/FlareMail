-- Bind inbound records to a workspace user. Unknown recipients remain
-- unassigned and therefore cannot be read through authenticated workspace APIs.

ALTER TABLE email_messages ADD COLUMN owner_user_id TEXT;

UPDATE email_messages
SET owner_user_id = (
  SELECT u.id
  FROM workspace_users AS u
  WHERE lower(u.login_email) = lower(email_messages."to")
     OR lower(u.email) = lower(email_messages."to")
  ORDER BY u.created_at ASC
  LIMIT 1
)
WHERE owner_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_email_messages_owner_cursor
  ON email_messages(owner_user_id, "timestamp" DESC, id DESC);
