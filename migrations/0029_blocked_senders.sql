CREATE TABLE blocked_senders (
  owner_user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, email)
);

CREATE TRIGGER blocked_senders_owner_delete AFTER DELETE ON workspace_users BEGIN
  DELETE FROM blocked_senders WHERE owner_user_id = old.id;
END;

ALTER TABLE workspace_email_states ADD COLUMN quarantined_at TEXT;
CREATE INDEX idx_workspace_email_states_quarantine
  ON workspace_email_states(user_id, quarantined_at DESC, email_message_id DESC)
  WHERE quarantined_at IS NOT NULL;

UPDATE workspace_schema_metadata
SET schema_version = 29, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE schema_name = 'flaremail';
