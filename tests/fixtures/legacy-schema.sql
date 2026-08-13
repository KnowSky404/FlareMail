-- Frozen legacy fixture: equivalent to the pre-migration schema.sql, with a
-- small set of representative rows. It deliberately has no new columns.

CREATE TABLE email_messages (
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
CREATE INDEX idx_email_messages_timestamp ON email_messages("timestamp" DESC);
CREATE INDEX idx_email_messages_from ON email_messages("from");
CREATE INDEX idx_email_messages_to ON email_messages("to");

CREATE TABLE workspace_users (
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
CREATE TABLE workspace_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE workspace_messages (
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
CREATE INDEX idx_workspace_sessions_user_id ON workspace_sessions(user_id);
CREATE INDEX idx_workspace_messages_user_folder_sent_at ON workspace_messages(user_id, folder, sent_at DESC);
CREATE INDEX idx_workspace_messages_user_starred ON workspace_messages(user_id, is_starred);

CREATE TABLE workspace_drafts (
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
CREATE INDEX idx_workspace_drafts_user_updated_at ON workspace_drafts(user_id, updated_at DESC);

CREATE TABLE workspace_email_states (
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
CREATE INDEX idx_workspace_email_states_user_updated_at ON workspace_email_states(user_id, updated_at DESC);

CREATE TABLE workspace_outbound_statuses (
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
CREATE INDEX idx_workspace_outbound_statuses_user_status ON workspace_outbound_statuses(user_id, status, updated_at DESC);
CREATE INDEX idx_workspace_outbound_statuses_provider_message_id ON workspace_outbound_statuses(provider_message_id);

CREATE TABLE workspace_outbound_receipts (
  message_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  result_kind TEXT NOT NULL CHECK (result_kind IN ('accepted', 'queued', 'temporary_failure', 'permanent_failure', 'rate_limited')),
  remote_status INTEGER,
  response_preview TEXT NOT NULL DEFAULT '',
  last_event TEXT NOT NULL DEFAULT 'submission',
  last_event_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_workspace_outbound_receipts_user_provider ON workspace_outbound_receipts(user_id, provider, updated_at DESC);

CREATE TABLE workspace_outbound_events (
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
CREATE INDEX idx_workspace_outbound_events_message_id ON workspace_outbound_events(message_id, event_created_at DESC);
CREATE INDEX idx_workspace_outbound_events_provider_message_id ON workspace_outbound_events(provider_message_id, event_created_at DESC);

INSERT INTO email_messages (id, message_id, "from", "to", subject, "timestamp", snippet, raw_key, raw_size)
VALUES ('legacy-email-1', '<legacy-1@example.test>', 'sender@example.test', 'admin@example.test', 'Legacy inbound', '2026-08-12T10:00:00.000Z', 'Legacy body', 'raw/legacy-email-1.eml', 128);
INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature)
VALUES ('legacy-user-1', 'admin@example.test', 'Legacy Admin', 'Owner', 'admin@example.test', 'Legacy Co', 'Berlin', 'Europe/Berlin', 1, 'Regards');
INSERT INTO workspace_sessions (id, user_id, created_at, updated_at)
VALUES ('legacy-session-1', 'legacy-user-1', '2026-08-12T10:00:00.000Z', '2026-08-12T11:00:00.000Z');
INSERT INTO workspace_messages (id, user_id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at)
VALUES ('legacy-message-1', 'legacy-user-1', 'inbox', 'Sender', 'sender@example.test', 'Legacy Admin', 'admin@example.test', 'Legacy inbound', 'Legacy body', 'Legacy body', '2026-08-12T10:00:00.000Z');
INSERT INTO workspace_messages (id, user_id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at)
VALUES ('legacy-message-2', 'legacy-user-1', 'sent', 'Legacy Admin', 'admin@example.test', 'Recipient', 'recipient@example.test', 'Legacy outbound', 'Sent body', 'Sent body', '2026-08-12T12:00:00.000Z');
INSERT INTO workspace_drafts (id, user_id, to_email, subject, body)
VALUES ('legacy-draft-1', 'legacy-user-1', 'recipient@example.test', 'Draft', 'Draft body');
INSERT INTO workspace_email_states (id, user_id, email_message_id, is_read, is_starred)
VALUES ('legacy-state-1', 'legacy-user-1', 'legacy-email-1', 0, 1);
INSERT INTO workspace_outbound_statuses (message_id, user_id, status, attempts, provider_message_id, created_at, updated_at)
VALUES ('legacy-message-2', 'legacy-user-1', 'sent', 2, 'provider-legacy-1', '2026-08-12T12:00:00.000Z', '2026-08-12T12:01:00.000Z');
INSERT INTO workspace_outbound_receipts (message_id, user_id, provider, result_kind, last_event_at)
VALUES ('legacy-message-2', 'legacy-user-1', 'legacy-provider', 'accepted', '2026-08-12T12:01:00.000Z');
INSERT INTO workspace_outbound_events (svix_id, message_id, user_id, provider, event_type, event_created_at)
VALUES ('legacy-svix-1', 'legacy-message-2', 'legacy-user-1', 'legacy-provider', 'email.sent', '2026-08-12T12:01:00.000Z');
