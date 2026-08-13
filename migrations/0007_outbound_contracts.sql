-- Persist compose threading and stable logical-send identity across autosave,
-- submission and retries.

ALTER TABLE workspace_drafts ADD COLUMN message_id TEXT;
ALTER TABLE workspace_drafts ADD COLUMN in_reply_to TEXT;
ALTER TABLE workspace_drafts ADD COLUMN "references" TEXT;
ALTER TABLE workspace_drafts ADD COLUMN thread_key TEXT;
ALTER TABLE workspace_drafts ADD COLUMN idempotency_key TEXT;

UPDATE workspace_drafts
SET idempotency_key = 'flaremail:draft:' || id
WHERE idempotency_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_drafts_idempotency_key
  ON workspace_drafts(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_drafts_thread_key
  ON workspace_drafts(user_id, thread_key, updated_at DESC);
