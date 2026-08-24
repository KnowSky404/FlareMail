-- Canonical large-body objects. Existing D1 body columns remain readable as legacy/inline projections.
ALTER TABLE email_messages ADD COLUMN body_object_id TEXT;
ALTER TABLE workspace_messages ADD COLUMN body_object_id TEXT;
ALTER TABLE workspace_drafts ADD COLUMN body_object_id TEXT;

CREATE TABLE mail_body_objects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('email_message', 'workspace_message', 'draft')),
  entity_id TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  text_bytes INTEGER NOT NULL DEFAULT 0 CHECK (text_bytes >= 0),
  html_bytes INTEGER NOT NULL DEFAULT 0 CHECK (html_bytes >= 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'delete_pending', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delete_after TEXT
);

CREATE INDEX idx_mail_body_cleanup ON mail_body_objects(state, delete_after);
CREATE INDEX idx_mail_body_owner ON mail_body_objects(owner_user_id, entity_type, entity_id);

INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
VALUES ('flaremail', 12, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(schema_name) DO UPDATE SET schema_version = excluded.schema_version, updated_at = excluded.updated_at;
