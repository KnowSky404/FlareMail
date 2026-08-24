-- Make the durable R2 cleanup pointer a bounded, lease-based work queue.
-- Existing rows are deliberately conservative: legacy/unverifiable keys are
-- visible but are never selected for automatic deletion.
ALTER TABLE workspace_r2_cleanup_queue ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'processing', 'retryable', 'completed', 'manual_review'));
ALTER TABLE workspace_r2_cleanup_queue ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (attempt_count >= 0);
ALTER TABLE workspace_r2_cleanup_queue ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 8
  CHECK (max_attempts > 0);
ALTER TABLE workspace_r2_cleanup_queue ADD COLUMN next_attempt_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE workspace_r2_cleanup_queue ADD COLUMN claim_token TEXT;
ALTER TABLE workspace_r2_cleanup_queue ADD COLUMN lease_expires_at TEXT;
ALTER TABLE workspace_r2_cleanup_queue ADD COLUMN last_error TEXT;
ALTER TABLE workspace_r2_cleanup_queue ADD COLUMN completed_at TEXT;
ALTER TABLE workspace_r2_cleanup_queue ADD COLUMN object_kind TEXT NOT NULL DEFAULT 'legacy'
  CHECK (object_kind IN ('raw', 'attachment', 'body', 'legacy'));
ALTER TABLE workspace_r2_cleanup_queue ADD COLUMN source_id TEXT;
ALTER TABLE workspace_r2_cleanup_queue ADD COLUMN source_owner_user_id TEXT;
ALTER TABLE workspace_r2_cleanup_queue ADD COLUMN source_entity_id TEXT;

UPDATE workspace_r2_cleanup_queue
SET next_attempt_at = created_at,
    status = 'manual_review',
    object_kind = 'legacy',
    last_error = 'invalid_key_scope'
WHERE status = 'pending';

CREATE INDEX idx_workspace_r2_cleanup_queue_claim
  ON workspace_r2_cleanup_queue(status, next_attempt_at, created_at, id);
CREATE INDEX idx_workspace_r2_cleanup_queue_lease
  ON workspace_r2_cleanup_queue(status, lease_expires_at);

UPDATE workspace_schema_metadata
SET schema_version = 17,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE schema_name = 'flaremail';
