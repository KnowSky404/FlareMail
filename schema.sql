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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_email_messages_timestamp
  ON email_messages("timestamp" DESC);

CREATE INDEX IF NOT EXISTS idx_email_messages_from
  ON email_messages("from");

CREATE INDEX IF NOT EXISTS idx_email_messages_to
  ON email_messages("to");

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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS workspace_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_sessions_user_id
  ON workspace_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_workspace_messages_user_folder_sent_at
  ON workspace_messages(user_id, folder, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_messages_user_starred
  ON workspace_messages(user_id, is_starred);

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

CREATE TABLE IF NOT EXISTS workspace_outbound_statuses (
  message_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  provider_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_outbound_statuses_user_status
  ON workspace_outbound_statuses(user_id, status, updated_at DESC);
