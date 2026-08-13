-- Delivery reconciliation model. The legacy outbound tables are retained for
-- compatibility; this table is the append-safe source for the complete
-- delivery state machine and can represent provider states that the old CHECK
-- constraint does not allow.

ALTER TABLE workspace_outbound_statuses ADD COLUMN idempotency_key TEXT;

UPDATE workspace_outbound_statuses AS s
SET idempotency_key = (
  SELECT m.idempotency_key
  FROM workspace_messages AS m
  WHERE m.id = s.message_id AND m.idempotency_key IS NOT NULL
)
WHERE s.idempotency_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_outbound_statuses_idempotency_key
  ON workspace_outbound_statuses(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_delivery_statuses (
  message_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'draft', 'queued', 'submitting', 'submitted', 'sent', 'delivered',
      'delayed', 'bounced', 'failed', 'complained', 'suppressed'
    )
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  idempotency_key TEXT,
  provider TEXT,
  provider_message_id TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  submitted_at TEXT,
  sent_at TEXT,
  delivered_at TEXT,
  last_event TEXT,
  last_event_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS workspace_delivery_attempts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  idempotency_key TEXT,
  provider TEXT,
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'queued', 'submitting', 'submitted', 'sent', 'delivered', 'delayed', 'bounced',
      'failed', 'complained', 'suppressed'
    )
  ),
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(message_id, attempt_number)
);

-- Copy the old state exactly once. INSERT OR IGNORE makes recovery from an
-- interrupted apply safe without changing any legacy row. Receipt provider
-- metadata is joined when available.
INSERT OR IGNORE INTO workspace_delivery_statuses (
  message_id, user_id, status, attempts, idempotency_key, provider,
  provider_message_id, last_error, delivered_at, last_event, last_event_at,
  created_at, updated_at
)
SELECT s.message_id, s.user_id,
  CASE s.status
    WHEN 'queued' THEN 'queued'
    WHEN 'sent' THEN 'sent'
    WHEN 'failed' THEN 'failed'
  END,
  s.attempts,
  s.idempotency_key,
  r.provider,
  s.provider_message_id,
  s.last_error,
  s.delivered_at,
  r.last_event,
  r.last_event_at,
  s.created_at,
  s.updated_at
FROM workspace_outbound_statuses AS s
LEFT JOIN workspace_outbound_receipts AS r ON r.message_id = s.message_id
WHERE NOT EXISTS (
  SELECT 1 FROM workspace_delivery_statuses AS d WHERE d.message_id = s.message_id
);

-- A legacy attempt counter cannot reconstruct every provider request. Preserve
-- its aggregate count and latest known result as one explicitly marked legacy
-- attempt; new writers record each attempt as it occurs.
INSERT OR IGNORE INTO workspace_delivery_attempts (
  id, message_id, user_id, attempt_number, idempotency_key, provider,
  provider_message_id, status, error, started_at, completed_at, created_at
)
SELECT 'legacy-attempt:' || s.message_id,
  s.message_id, s.user_id, s.attempts, s.idempotency_key, r.provider,
  s.provider_message_id,
  CASE s.status
    WHEN 'queued' THEN 'queued'
    WHEN 'sent' THEN 'sent'
    WHEN 'failed' THEN 'failed'
  END,
  NULLIF(s.last_error, ''), s.created_at, s.updated_at, s.created_at
FROM workspace_outbound_statuses AS s
LEFT JOIN workspace_outbound_receipts AS r ON r.message_id = s.message_id
WHERE s.attempts > 0
  AND NOT EXISTS (
    SELECT 1 FROM workspace_delivery_attempts AS a
    WHERE a.message_id = s.message_id AND a.attempt_number = s.attempts
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_delivery_statuses_idempotency_key
  ON workspace_delivery_statuses(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_delivery_statuses_provider_message_id
  ON workspace_delivery_statuses(provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_delivery_statuses_user_status
  ON workspace_delivery_statuses(user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_delivery_attempts_message_id
  ON workspace_delivery_attempts(message_id, attempt_number DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_delivery_attempts_provider_message_id
  ON workspace_delivery_attempts(provider_message_id)
  WHERE provider_message_id IS NOT NULL;
