-- Archive state and bounded bulk mailbox mutations.
-- Archive is a per-user state, not a persisted folder, so existing inbox/sent
-- CHECK constraints and RFC thread keys remain unchanged.

ALTER TABLE workspace_messages ADD COLUMN archived_at TEXT;
ALTER TABLE workspace_email_states ADD COLUMN archived_at TEXT;

CREATE INDEX IF NOT EXISTS idx_workspace_messages_user_folder_archived
  ON workspace_messages(user_id, folder, archived_at, sent_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_email_states_user_archived
  ON workspace_email_states(user_id, archived_at, updated_at DESC);

UPDATE workspace_schema_metadata
SET schema_version = 10,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE schema_name = 'flaremail';
