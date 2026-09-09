-- Telegram binding, durable notification outbox, webhook deduplication and
-- cross-Worker rate-limit state. Telegram is intentionally additive: existing
-- mail, Resend and legacy notification data are not rewritten.
CREATE TABLE workspace_telegram_bindings (
  user_id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('candidate', 'active', 'revoked')),
  telegram_user_id TEXT,
  telegram_chat_id TEXT,
  telegram_username TEXT,
  telegram_display_name TEXT NOT NULL DEFAULT '',
  candidate_challenge_id TEXT,
  candidate_expires_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  privacy_mode INTEGER NOT NULL DEFAULT 0 CHECK (privacy_mode IN (0, 1)),
  summary_enabled INTEGER NOT NULL DEFAULT 0 CHECK (summary_enabled IN (0, 1)),
  authorization_version INTEGER NOT NULL DEFAULT 1 CHECK (authorization_version > 0),
  bound_at TEXT,
  confirmed_at TEXT,
  revoked_at TEXT,
  last_sent_at TEXT,
  last_error_code TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    state = 'revoked'
    OR (telegram_user_id IS NOT NULL AND telegram_chat_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_workspace_telegram_bindings_target
  ON workspace_telegram_bindings(telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL AND state IN ('candidate', 'active');
CREATE INDEX idx_workspace_telegram_bindings_state
  ON workspace_telegram_bindings(state, enabled, updated_at DESC);

CREATE TABLE workspace_telegram_bind_challenges (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'replaced', 'expired')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  replaced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_workspace_telegram_challenges_owner
  ON workspace_telegram_bind_challenges(owner_user_id, status, expires_at);
CREATE INDEX idx_workspace_telegram_challenges_expiry
  ON workspace_telegram_bind_challenges(status, expires_at);

CREATE TABLE workspace_telegram_updates (
  update_id TEXT PRIMARY KEY,
  processing_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('processing', 'processed', 'ignored')),
  result_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

CREATE INDEX idx_workspace_telegram_updates_created
  ON workspace_telegram_updates(created_at);

CREATE TABLE workspace_telegram_deliveries (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  email_message_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'telegram' CHECK (channel = 'telegram'),
  binding_id TEXT NOT NULL,
  authorization_version INTEGER NOT NULL CHECK (authorization_version > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'retryable', 'sent', 'failed', 'unknown_delivery', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  next_attempt_at TEXT NOT NULL,
  claim_token TEXT,
  lease_expires_at TEXT,
  external_started INTEGER NOT NULL DEFAULT 0 CHECK (external_started IN (0, 1)),
  external_started_at TEXT,
  telegram_message_id TEXT,
  last_error_code TEXT,
  last_error_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(channel, owner_user_id, email_message_id)
);

CREATE INDEX idx_workspace_telegram_deliveries_claim
  ON workspace_telegram_deliveries(status, next_attempt_at, created_at, id);
CREATE INDEX idx_workspace_telegram_deliveries_lease
  ON workspace_telegram_deliveries(status, lease_expires_at);
CREATE INDEX idx_workspace_telegram_deliveries_owner_history
  ON workspace_telegram_deliveries(owner_user_id, created_at DESC, id DESC);
CREATE INDEX idx_workspace_telegram_deliveries_email
  ON workspace_telegram_deliveries(owner_user_id, email_message_id);

CREATE TABLE workspace_telegram_rate_limits (
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  window_started_at INTEGER NOT NULL,
  reset_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, action)
);

CREATE INDEX idx_workspace_telegram_rate_limits_reset
  ON workspace_telegram_rate_limits(reset_at);

CREATE TABLE workspace_telegram_delivery_limits (
  scope TEXT PRIMARY KEY,
  next_allowed_at TEXT,
  cooldown_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_workspace_telegram_delivery_limits_cooldown
  ON workspace_telegram_delivery_limits(cooldown_until, next_allowed_at);

INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
VALUES ('flaremail', 19, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(schema_name) DO UPDATE SET schema_version = excluded.schema_version, updated_at = excluded.updated_at;
