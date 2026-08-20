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
  body_object_id TEXT,
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  reply_to_json TEXT NOT NULL DEFAULT '[]',
  return_path TEXT,
  delivered_to TEXT,
  headers_json TEXT NOT NULL DEFAULT '[]',
  authentication_results_json TEXT NOT NULL DEFAULT '[]',
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
  to_json TEXT NOT NULL DEFAULT '[]',
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
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  dedupe_key TEXT,
  provider_message_id TEXT,
  idempotency_key TEXT,
  archived_at TEXT,
  deleted_at TEXT,
  body_object_id TEXT,
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
CREATE INDEX IF NOT EXISTS idx_workspace_messages_user_folder_archived ON workspace_messages(user_id, folder, archived_at, sent_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_messages_user_trash ON workspace_messages(user_id, deleted_at, sent_at DESC, id DESC);

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
  relation_type TEXT NOT NULL DEFAULT 'inbound' CHECK (relation_type IN ('inbound', 'draft', 'message')),
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('uploading', 'ready', 'failed', 'delete_pending')),
  sha256 TEXT,
  disposition TEXT NOT NULL DEFAULT 'attachment' CHECK (disposition IN ('attachment', 'inline')),
  updated_at TEXT NOT NULL DEFAULT '',
  delete_after TEXT,
  UNIQUE(message_id, r2_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_attachments_user_message ON workspace_attachments(user_id, message_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_attachments_content_id ON workspace_attachments(message_id, content_id) WHERE content_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_attachments_user_relation
  ON workspace_attachments(user_id, relation_type, message_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_attachments_cleanup
  ON workspace_attachments(state, delete_after)
  WHERE state IN ('uploading', 'failed', 'delete_pending');

CREATE TABLE IF NOT EXISTS workspace_r2_cleanup_queue (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL CHECK (reason IN ('trash_delete')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'retryable', 'completed', 'manual_review')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  next_attempt_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
  claim_token TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  completed_at TEXT,
  object_kind TEXT NOT NULL DEFAULT 'legacy' CHECK (object_kind IN ('raw', 'attachment', 'body', 'legacy')),
  source_id TEXT,
  source_owner_user_id TEXT,
  source_entity_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_r2_cleanup_queue_owner_entity
  ON workspace_r2_cleanup_queue(owner_user_id, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workspace_r2_cleanup_queue_claim
  ON workspace_r2_cleanup_queue(status, next_attempt_at, created_at, id);
CREATE INDEX IF NOT EXISTS idx_workspace_r2_cleanup_queue_lease
  ON workspace_r2_cleanup_queue(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS workspace_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  to_email TEXT NOT NULL DEFAULT '',
  cc TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  is_starred INTEGER NOT NULL DEFAULT 0,
  message_id TEXT,
  in_reply_to TEXT,
  "references" TEXT,
  thread_key TEXT,
  idempotency_key TEXT,
  body_object_id TEXT,
  deleted_at TEXT,
  attachment_revision INTEGER NOT NULL DEFAULT 0 CHECK (attachment_revision >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_drafts_user_updated_at
  ON workspace_drafts(user_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_drafts_idempotency_key ON workspace_drafts(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_drafts_thread_key ON workspace_drafts(user_id, thread_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_drafts_user_trash ON workspace_drafts(user_id, deleted_at, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS mail_body_objects (
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

CREATE INDEX IF NOT EXISTS idx_mail_body_cleanup ON mail_body_objects(state, delete_after);
CREATE INDEX IF NOT EXISTS idx_mail_body_owner ON mail_body_objects(owner_user_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS workspace_email_states (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email_message_id TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(user_id, email_message_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_email_states_user_updated_at
  ON workspace_email_states(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_email_states_user_archived
  ON workspace_email_states(user_id, archived_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_email_states_user_trash
  ON workspace_email_states(user_id, deleted_at, updated_at DESC, email_message_id);

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

CREATE TABLE IF NOT EXISTS workspace_login_rate_limits (
  identity_hash TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  window_started_at INTEGER NOT NULL,
  reset_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_login_rate_limits_reset_at
  ON workspace_login_rate_limits(reset_at);

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

CREATE TABLE IF NOT EXISTS workspace_inbound_ingest_claims (
  dedupe_key TEXT PRIMARY KEY,
  storage_id TEXT NOT NULL UNIQUE,
  claim_token TEXT NOT NULL UNIQUE,
  raw_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workspace_inbound_ingest_claims_status_updated
  ON workspace_inbound_ingest_claims(status, updated_at);

CREATE TABLE IF NOT EXISTS workspace_schema_metadata (
  schema_name TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  updated_at TEXT NOT NULL
);

-- Rebuildable, owner-scoped full-text projections. Canonical mail rows remain
-- the source of truth; this table deliberately excludes BCC, raw MIME,
-- attachment bytes and secrets.
CREATE TABLE workspace_search_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('inbound', 'message', 'draft')),
  entity_id TEXT NOT NULL,
  from_text TEXT NOT NULL DEFAULT '' CHECK (length(CAST(from_text AS BLOB)) <= 8192),
  to_text TEXT NOT NULL DEFAULT '' CHECK (length(CAST(to_text AS BLOB)) <= 16384),
  cc_text TEXT NOT NULL DEFAULT '' CHECK (length(CAST(cc_text AS BLOB)) <= 16384),
  subject_text TEXT NOT NULL DEFAULT '' CHECK (length(CAST(subject_text AS BLOB)) <= 4096),
  body_text TEXT NOT NULL DEFAULT '' CHECK (length(CAST(body_text AS BLOB)) <= 65536),
  labels_text TEXT NOT NULL DEFAULT '' CHECK (length(CAST(labels_text AS BLOB)) <= 16384),
  indexed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(user_id, entity_kind, entity_id)
);

CREATE INDEX idx_workspace_search_documents_owner
  ON workspace_search_documents(user_id, entity_kind, entity_id);

CREATE VIRTUAL TABLE workspace_search_fts USING fts5(
  from_text,
  to_text,
  cc_text,
  subject_text,
  body_text,
  labels_text,
  content='workspace_search_documents',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER workspace_search_documents_ai AFTER INSERT ON workspace_search_documents BEGIN
  INSERT INTO workspace_search_fts(rowid, from_text, to_text, cc_text, subject_text, body_text, labels_text)
  VALUES (new.id, new.from_text, new.to_text, new.cc_text, new.subject_text, new.body_text, new.labels_text);
END;

CREATE TRIGGER workspace_search_documents_ad AFTER DELETE ON workspace_search_documents BEGIN
  INSERT INTO workspace_search_fts(workspace_search_fts, rowid, from_text, to_text, cc_text, subject_text, body_text, labels_text)
  VALUES ('delete', old.id, old.from_text, old.to_text, old.cc_text, old.subject_text, old.body_text, old.labels_text);
END;

CREATE TRIGGER workspace_search_documents_au AFTER UPDATE ON workspace_search_documents BEGIN
  INSERT INTO workspace_search_fts(workspace_search_fts, rowid, from_text, to_text, cc_text, subject_text, body_text, labels_text)
  VALUES ('delete', old.id, old.from_text, old.to_text, old.cc_text, old.subject_text, old.body_text, old.labels_text);
  INSERT INTO workspace_search_fts(rowid, from_text, to_text, cc_text, subject_text, body_text, labels_text)
  VALUES (new.id, new.from_text, new.to_text, new.cc_text, new.subject_text, new.body_text, new.labels_text);
END;

CREATE TRIGGER email_messages_search_ai AFTER INSERT ON email_messages WHEN new.owner_user_id IS NOT NULL BEGIN
  INSERT INTO workspace_search_documents
    (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at)
  VALUES (
    new.owner_user_id, 'inbound', new.id,
    substr(new."from", 1, 2048),
    substr(new."to" || ' ' || new.to_json, 1, 4096),
    substr(new.cc || ' ' || new.cc_json, 1, 4096),
    substr(new.subject, 1, 1024),
    substr(CASE WHEN new.text_body <> '' THEN new.text_body ELSE new.snippet END, 1, 16384),
    'Inbound Cloudflare',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER email_messages_search_au
AFTER UPDATE OF owner_user_id, "from", "to", to_json, cc, cc_json, subject, text_body, snippet ON email_messages BEGIN
  DELETE FROM workspace_search_documents WHERE entity_kind = 'inbound' AND entity_id = old.id;
  INSERT INTO workspace_search_documents
    (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at)
  SELECT
    new.owner_user_id, 'inbound', new.id,
    substr(new."from", 1, 2048),
    substr(new."to" || ' ' || new.to_json, 1, 4096),
    substr(new.cc || ' ' || new.cc_json, 1, 4096),
    substr(new.subject, 1, 1024),
    substr(CASE WHEN new.text_body <> '' THEN new.text_body ELSE new.snippet END, 1, 16384),
    'Inbound Cloudflare',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE new.owner_user_id IS NOT NULL;
END;

CREATE TRIGGER email_messages_search_ad AFTER DELETE ON email_messages BEGIN
  DELETE FROM workspace_search_documents WHERE entity_kind = 'inbound' AND entity_id = old.id;
END;

CREATE TRIGGER workspace_messages_search_ai AFTER INSERT ON workspace_messages BEGIN
  INSERT INTO workspace_search_documents
    (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at)
  VALUES (
    new.user_id, 'message', new.id,
    substr(new.from_name || ' ' || new.from_email, 1, 2048),
    substr(new.to_name || ' ' || new.to_email || ' ' || new.to_json, 1, 4096),
    substr(new.cc || ' ' || new.cc_json, 1, 4096),
    substr(new.subject, 1, 1024),
    substr(CASE WHEN new.text_body <> '' THEN new.text_body WHEN new.body <> '' THEN new.body ELSE new.preview END, 1, 16384),
    substr(new.labels_json, 1, 4096),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER workspace_messages_search_au
AFTER UPDATE OF user_id, from_name, from_email, to_name, to_email, to_json, cc, cc_json, subject, text_body, body, preview, labels_json ON workspace_messages BEGIN
  DELETE FROM workspace_search_documents WHERE entity_kind = 'message' AND entity_id = old.id;
  INSERT INTO workspace_search_documents
    (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at)
  VALUES (
    new.user_id, 'message', new.id,
    substr(new.from_name || ' ' || new.from_email, 1, 2048),
    substr(new.to_name || ' ' || new.to_email || ' ' || new.to_json, 1, 4096),
    substr(new.cc || ' ' || new.cc_json, 1, 4096),
    substr(new.subject, 1, 1024),
    substr(CASE WHEN new.text_body <> '' THEN new.text_body WHEN new.body <> '' THEN new.body ELSE new.preview END, 1, 16384),
    substr(new.labels_json, 1, 4096),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER workspace_messages_search_ad AFTER DELETE ON workspace_messages BEGIN
  DELETE FROM workspace_search_documents WHERE entity_kind = 'message' AND entity_id = old.id;
END;

CREATE TRIGGER workspace_drafts_search_ai AFTER INSERT ON workspace_drafts BEGIN
  INSERT INTO workspace_search_documents
    (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at)
  VALUES (
    new.user_id, 'draft', new.id, '',
    substr(new.to_email || ' ' || new.to_json, 1, 4096),
    substr(new.cc || ' ' || new.cc_json, 1, 4096),
    substr(new.subject, 1, 1024),
    substr(new.body, 1, 16384),
    'Draft',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER workspace_drafts_search_au
AFTER UPDATE OF user_id, to_email, to_json, cc, cc_json, subject, body ON workspace_drafts BEGIN
  DELETE FROM workspace_search_documents WHERE entity_kind = 'draft' AND entity_id = old.id;
  INSERT INTO workspace_search_documents
    (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at)
  VALUES (
    new.user_id, 'draft', new.id, '',
    substr(new.to_email || ' ' || new.to_json, 1, 4096),
    substr(new.cc || ' ' || new.cc_json, 1, 4096),
    substr(new.subject, 1, 1024),
    substr(new.body, 1, 16384),
    'Draft',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER workspace_drafts_search_ad AFTER DELETE ON workspace_drafts BEGIN
  DELETE FROM workspace_search_documents WHERE entity_kind = 'draft' AND entity_id = old.id;
END;
