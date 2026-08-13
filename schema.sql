CREATE TABLE IF NOT EXISTS email_messages (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  "from" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  "timestamp" TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  raw_key TEXT NOT NULL,
  raw_size INTEGER NOT NULL DEFAULT 0,
  in_reply_to TEXT,
  "references" TEXT,
  thread_key TEXT,
  direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound')),
  text_body TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL DEFAULT '',
  cc TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT,
  provider_message_id TEXT,
  idempotency_key TEXT,
  owner_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_email_messages_timestamp
  ON email_messages("timestamp" DESC);

CREATE INDEX IF NOT EXISTS idx_email_messages_from
  ON email_messages("from");

CREATE INDEX IF NOT EXISTS idx_email_messages_to
  ON email_messages("to");

CREATE INDEX IF NOT EXISTS idx_email_messages_message_id ON email_messages(message_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_thread_key ON email_messages(thread_key, "timestamp" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_dedupe_key ON email_messages(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_messages_provider_message_id ON email_messages(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_messages_recipient_cursor ON email_messages("to", "timestamp" DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_owner_cursor ON email_messages(owner_user_id, "timestamp" DESC, id DESC);

CREATE TABLE IF NOT EXISTS workspace_users (
  id TEXT PRIMARY KEY,
  login_email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT NOT NULL,
  timezone TEXT NOT NULL,
  forwarding_enabled INTEGER NOT NULL DEFAULT 1,
  signature TEXT NOT NULL DEFAULT '',
  incoming_sequence INTEGER NOT NULL DEFAULT 0,
  credential_hash TEXT,
  credential_salt TEXT,
  credential_iterations INTEGER,
  credential_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS workspace_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS workspace_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  folder TEXT NOT NULL CHECK (folder IN ('inbox', 'sent')),
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  to_name TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  preview TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  sent_at TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '[]',
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  message_id TEXT,
  in_reply_to TEXT,
  "references" TEXT,
  thread_key TEXT,
  direction TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('inbound', 'outbound')),
  text_body TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL DEFAULT '',
  cc TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT,
  provider_message_id TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_sessions_user_id
  ON workspace_sessions(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_sessions_token_hash ON workspace_sessions(token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_sessions_expires_at ON workspace_sessions(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_sessions_cleanup ON workspace_sessions(revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_workspace_messages_user_folder_sent_at
  ON workspace_messages(user_id, folder, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_messages_user_starred
  ON workspace_messages(user_id, is_starred);

CREATE INDEX IF NOT EXISTS idx_workspace_messages_thread_key ON workspace_messages(user_id, thread_key, sent_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_messages_dedupe_key ON workspace_messages(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_messages_idempotency_key ON workspace_messages(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_messages_provider_message_id ON workspace_messages(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_messages_user_folder_cursor ON workspace_messages(user_id, folder, sent_at DESC, id DESC);

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

CREATE INDEX IF NOT EXISTS idx_workspace_attachments_user_message ON workspace_attachments(user_id, message_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_attachments_content_id ON workspace_attachments(message_id, content_id) WHERE content_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  to_email TEXT NOT NULL DEFAULT '',
  cc TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  is_starred INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_drafts_user_updated_at
  ON workspace_drafts(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_email_states (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email_message_id TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(user_id, email_message_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_email_states_user_updated_at
  ON workspace_email_states(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_settings (
  user_id TEXT PRIMARY KEY,
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_settings_theme ON workspace_settings(theme);

CREATE TABLE IF NOT EXISTS workspace_outbound_statuses (
  message_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  provider_message_id TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_outbound_statuses_user_status
  ON workspace_outbound_statuses(user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_outbound_statuses_provider_message_id
  ON workspace_outbound_statuses(provider_message_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_outbound_statuses_idempotency_key
  ON workspace_outbound_statuses(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_outbound_receipts (
  message_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  result_kind TEXT NOT NULL CHECK (
    result_kind IN ('accepted', 'queued', 'temporary_failure', 'permanent_failure', 'rate_limited')
  ),
  remote_status INTEGER,
  response_preview TEXT NOT NULL DEFAULT '',
  last_event TEXT NOT NULL DEFAULT 'submission',
  last_event_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_outbound_receipts_user_provider
  ON workspace_outbound_receipts(user_id, provider, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_outbound_events (
  svix_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  event_type TEXT NOT NULL,
  event_created_at TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_outbound_events_message_id
  ON workspace_outbound_events(message_id, event_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_outbound_events_provider_message_id
  ON workspace_outbound_events(provider_message_id, event_created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_delivery_statuses (
  message_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'submitting', 'submitted', 'sent', 'delivered', 'delayed', 'bounced', 'failed', 'complained', 'suppressed')),
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
  status TEXT NOT NULL CHECK (status IN ('queued', 'submitting', 'submitted', 'sent', 'delivered', 'delayed', 'bounced', 'failed', 'complained', 'suppressed')),
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(message_id, attempt_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_delivery_statuses_idempotency_key ON workspace_delivery_statuses(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_delivery_statuses_provider_message_id ON workspace_delivery_statuses(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_delivery_statuses_user_status ON workspace_delivery_statuses(user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_delivery_attempts_message_id ON workspace_delivery_attempts(message_id, attempt_number DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_delivery_attempts_provider_message_id ON workspace_delivery_attempts(provider_message_id) WHERE provider_message_id IS NOT NULL;
