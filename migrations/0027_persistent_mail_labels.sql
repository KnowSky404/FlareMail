CREATE TABLE mail_labels (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES workspace_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 48),
  name_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id, id),
  UNIQUE(owner_user_id, name_key)
);

CREATE INDEX idx_mail_labels_owner_name ON mail_labels(owner_user_id, name_key);

CREATE TABLE mail_message_labels (
  owner_user_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  message_kind TEXT NOT NULL CHECK (message_kind IN ('workspace', 'draft', 'inbound')),
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_user_id, label_id, message_kind, message_id),
  FOREIGN KEY(owner_user_id, label_id) REFERENCES mail_labels(owner_user_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_mail_message_labels_message
  ON mail_message_labels(owner_user_id, message_kind, message_id, label_id);

CREATE TRIGGER mail_message_labels_workspace_delete AFTER DELETE ON workspace_messages BEGIN
  DELETE FROM mail_message_labels
  WHERE owner_user_id = old.user_id AND message_kind = 'workspace' AND message_id = old.id;
END;

CREATE TRIGGER mail_message_labels_draft_delete AFTER DELETE ON workspace_drafts BEGIN
  DELETE FROM mail_message_labels
  WHERE owner_user_id = old.user_id AND message_kind = 'draft' AND message_id = old.id;
END;

CREATE TRIGGER mail_message_labels_inbound_delete AFTER DELETE ON email_messages BEGIN
  DELETE FROM mail_message_labels
  WHERE owner_user_id = old.owner_user_id AND message_kind = 'inbound' AND message_id = old.id;
END;

CREATE TRIGGER mail_labels_owner_delete AFTER DELETE ON workspace_users BEGIN
  DELETE FROM mail_message_labels WHERE owner_user_id = old.id;
  DELETE FROM mail_labels WHERE owner_user_id = old.id;
END;

INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
VALUES ('flaremail', 27, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(schema_name) DO UPDATE SET schema_version = excluded.schema_version, updated_at = excluded.updated_at;
