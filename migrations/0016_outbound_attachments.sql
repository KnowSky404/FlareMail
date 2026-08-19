-- Extend the R2-backed attachment metadata for draft and outbound lifecycles.
-- Existing inbound rows remain addressable by message_id and are promoted to
-- the ready/inbound state without copying any binary data into D1.
ALTER TABLE workspace_attachments ADD COLUMN relation_type TEXT NOT NULL DEFAULT 'inbound'
  CHECK (relation_type IN ('inbound', 'draft', 'message'));
ALTER TABLE workspace_attachments ADD COLUMN state TEXT NOT NULL DEFAULT 'ready'
  CHECK (state IN ('uploading', 'ready', 'failed', 'delete_pending'));
ALTER TABLE workspace_attachments ADD COLUMN sha256 TEXT;
ALTER TABLE workspace_attachments ADD COLUMN disposition TEXT NOT NULL DEFAULT 'attachment'
  CHECK (disposition IN ('attachment', 'inline'));
ALTER TABLE workspace_attachments ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_attachments ADD COLUMN delete_after TEXT;

UPDATE workspace_attachments
SET disposition = CASE WHEN inline = 1 THEN 'inline' ELSE 'attachment' END,
    updated_at = created_at
WHERE updated_at = '';

ALTER TABLE workspace_drafts ADD COLUMN attachment_revision INTEGER NOT NULL DEFAULT 0
  CHECK (attachment_revision >= 0);

CREATE INDEX idx_workspace_attachments_user_relation
  ON workspace_attachments(user_id, relation_type, message_id, state, created_at DESC);

CREATE INDEX idx_workspace_attachments_cleanup
  ON workspace_attachments(state, delete_after)
  WHERE state IN ('uploading', 'failed', 'delete_pending');

-- Keep a durable retry pointer when permanent trash deletion commits in D1
-- but the corresponding R2 delete is temporarily unavailable.
CREATE TABLE workspace_r2_cleanup_queue (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL CHECK (reason IN ('trash_delete')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_workspace_r2_cleanup_queue_owner_entity
  ON workspace_r2_cleanup_queue(owner_user_id, entity_id, created_at);

INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
VALUES ('flaremail', 16, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(schema_name) DO UPDATE SET schema_version = excluded.schema_version, updated_at = excluded.updated_at;
