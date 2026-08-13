-- Mail contracts: add RFC threading, body variants and stable dedupe data.
-- All additions are nullable or have a legacy-safe default. Existing rows are
-- backfilled in place; no legacy row is copied, moved or deleted. Wrangler's
-- migration ledger applies this ALTER file once; do not execute it directly.

ALTER TABLE email_messages ADD COLUMN in_reply_to TEXT;
ALTER TABLE email_messages ADD COLUMN "references" TEXT;
ALTER TABLE email_messages ADD COLUMN thread_key TEXT;
ALTER TABLE email_messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound'
  CHECK (direction IN ('inbound', 'outbound'));
ALTER TABLE email_messages ADD COLUMN text_body TEXT NOT NULL DEFAULT '';
ALTER TABLE email_messages ADD COLUMN html_body TEXT NOT NULL DEFAULT '';
ALTER TABLE email_messages ADD COLUMN cc TEXT NOT NULL DEFAULT '';
ALTER TABLE email_messages ADD COLUMN dedupe_key TEXT;
ALTER TABLE email_messages ADD COLUMN provider_message_id TEXT;
ALTER TABLE email_messages ADD COLUMN idempotency_key TEXT;

ALTER TABLE workspace_messages ADD COLUMN message_id TEXT;
ALTER TABLE workspace_messages ADD COLUMN in_reply_to TEXT;
ALTER TABLE workspace_messages ADD COLUMN "references" TEXT;
ALTER TABLE workspace_messages ADD COLUMN thread_key TEXT;
ALTER TABLE workspace_messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'outbound'
  CHECK (direction IN ('inbound', 'outbound'));
ALTER TABLE workspace_messages ADD COLUMN text_body TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_messages ADD COLUMN html_body TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_messages ADD COLUMN cc TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_messages ADD COLUMN dedupe_key TEXT;
ALTER TABLE workspace_messages ADD COLUMN provider_message_id TEXT;
ALTER TABLE workspace_messages ADD COLUMN idempotency_key TEXT;

-- Re-running these UPDATE statements is harmless: they only fill values that
-- are still at their legacy defaults. A valid, unique RFC Message-ID gets a
-- stable key; a damaged legacy database containing duplicate IDs gets a
-- deterministic id suffix so no historical row is lost while new duplicates
-- remain rejected by the unique index below.
UPDATE email_messages
SET text_body = snippet
WHERE text_body = '' AND snippet <> '';

UPDATE email_messages
SET thread_key = CASE
  WHEN message_id IS NOT NULL AND trim(message_id) <> '' THEN 'rfc:' || lower(trim(message_id))
  ELSE 'legacy:' || id
END
WHERE thread_key IS NULL OR trim(thread_key) = '';

UPDATE email_messages
SET dedupe_key = CASE
  WHEN message_id IS NOT NULL AND trim(message_id) <> ''
    AND (
      SELECT COUNT(*)
      FROM email_messages AS duplicate
      WHERE lower(trim(duplicate.message_id)) = lower(trim(email_messages.message_id))
        AND lower(trim(duplicate."to")) = lower(trim(email_messages."to"))
    ) = 1
    THEN 'rfc:' || lower(trim(message_id)) || ':to:' || lower(trim("to"))
  WHEN message_id IS NOT NULL AND trim(message_id) <> ''
    THEN 'rfc:' || lower(trim(message_id)) || ':to:' || lower(trim("to")) || ':legacy:' || id
  ELSE 'legacy:' || id
END
WHERE dedupe_key IS NULL OR trim(dedupe_key) = '';

UPDATE workspace_messages
SET text_body = body
WHERE text_body = '' AND body <> '';

UPDATE workspace_messages
SET direction = CASE WHEN folder = 'inbox' THEN 'inbound' ELSE 'outbound' END
WHERE direction = 'outbound' AND folder = 'inbox';

UPDATE workspace_messages
SET thread_key = 'legacy:' || id
WHERE thread_key IS NULL OR trim(thread_key) = '';

UPDATE workspace_messages
SET dedupe_key = 'legacy:' || id
WHERE dedupe_key IS NULL OR trim(dedupe_key) = '';

CREATE TABLE IF NOT EXISTS workspace_attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0 CHECK (size >= 0),
  inline INTEGER NOT NULL DEFAULT 0 CHECK (inline IN (0, 1)),
  content_id TEXT,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(message_id, r2_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_attachments_user_message
  ON workspace_attachments(user_id, message_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_attachments_content_id
  ON workspace_attachments(message_id, content_id)
  WHERE content_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_messages_message_id
  ON email_messages(message_id);

CREATE INDEX IF NOT EXISTS idx_email_messages_thread_key
  ON email_messages(thread_key, "timestamp" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_dedupe_key
  ON email_messages(dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_messages_provider_message_id
  ON email_messages(provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_messages_thread_key
  ON workspace_messages(user_id, thread_key, sent_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_messages_dedupe_key
  ON workspace_messages(dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_messages_idempotency_key
  ON workspace_messages(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_messages_provider_message_id
  ON workspace_messages(provider_message_id)
  WHERE provider_message_id IS NOT NULL;
