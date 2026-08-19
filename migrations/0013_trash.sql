-- Soft-delete state for workspace-owned messages and drafts. Inbound rows
-- continue to use workspace_email_states.deleted_at for compatibility.
ALTER TABLE workspace_messages ADD COLUMN deleted_at TEXT;
ALTER TABLE workspace_drafts ADD COLUMN deleted_at TEXT;

CREATE INDEX idx_workspace_messages_user_trash
  ON workspace_messages(user_id, deleted_at, sent_at DESC, id DESC);
CREATE INDEX idx_workspace_drafts_user_trash
  ON workspace_drafts(user_id, deleted_at, updated_at DESC, id DESC);
CREATE INDEX idx_workspace_email_states_user_trash
  ON workspace_email_states(user_id, deleted_at, updated_at DESC, email_message_id);

INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
VALUES ('flaremail', 13, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(schema_name) DO UPDATE SET schema_version = excluded.schema_version, updated_at = excluded.updated_at;
