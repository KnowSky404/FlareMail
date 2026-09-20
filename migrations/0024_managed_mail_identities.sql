-- Mail domains and addresses are explicit sending/receiving resources owned
-- by the stable workspace Owner. No legacy login or profile email is promoted.
CREATE TABLE mail_domains (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  domain_name TEXT NOT NULL COLLATE NOCASE
    CHECK (length(domain_name) BETWEEN 1 AND 253 AND instr(domain_name, '.') > 0),
  cloudflare_zone_id TEXT NOT NULL CHECK (length(cloudflare_zone_id) BETWEEN 1 AND 64),
  cloudflare_account_id TEXT,
  worker_name TEXT NOT NULL CHECK (length(worker_name) BETWEEN 1 AND 253),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  unknown_recipient_policy TEXT NOT NULL DEFAULT 'reject'
    CHECK (unknown_recipient_policy IN ('reject', 'collect')),
  catch_all_target TEXT NOT NULL DEFAULT 'unknown'
    CHECK (catch_all_target IN ('unknown', 'this_worker', 'external', 'drop', 'none')),
  catch_all_checked_at TEXT,
  resend_domain_id TEXT,
  resend_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (resend_status IN ('unknown', 'pending', 'verified', 'failed')),
  resend_sending_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (resend_sending_status IN ('unknown', 'enabled', 'disabled')),
  resend_checked_at TEXT,
  cloudflare_checked_at TEXT,
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),
  last_error_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(owner_user_id, domain_name),
  UNIQUE(cloudflare_zone_id, domain_name)
);

CREATE TABLE mail_addresses (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE
    CHECK (
      length(email) BETWEEN 3 AND 90
      AND instr(email, '@') > 1
      AND instr(email, '@') < length(email)
      AND length(email) - length(replace(email, '@', '')) = 1
    ),
  local_part TEXT NOT NULL CHECK (length(local_part) BETWEEN 1 AND 64),
  display_name TEXT NOT NULL DEFAULT '' CHECK (length(display_name) <= 128),
  signature TEXT NOT NULL DEFAULT '' CHECK (length(CAST(signature AS BLOB)) <= 16384),
  receive_enabled INTEGER NOT NULL DEFAULT 0 CHECK (receive_enabled IN (0, 1)),
  send_enabled INTEGER NOT NULL DEFAULT 0 CHECK (send_enabled IN (0, 1)),
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active', 'disabled', 'deleted')),
  routing_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (routing_state IN ('pending', 'provisioning', 'active', 'deleting', 'imported', 'unknown', 'error', 'deleted')),
  routing_rule_id TEXT,
  routing_rule_source TEXT CHECK (routing_rule_source IS NULL OR routing_rule_source IN ('api', 'wrangler')),
  routing_owner TEXT CHECK (routing_owner IS NULL OR routing_owner IN ('flaremail', 'imported')),
  is_default_sender INTEGER NOT NULL DEFAULT 0 CHECK (is_default_sender IN (0, 1)),
  operation_token TEXT,
  operation_expires_at TEXT,
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),
  last_error_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(email)
);

CREATE INDEX idx_mail_domains_owner_enabled ON mail_domains(owner_user_id, enabled, domain_name);
CREATE INDEX idx_mail_domains_zone ON mail_domains(cloudflare_zone_id, domain_name);
CREATE INDEX idx_mail_addresses_owner_lifecycle
  ON mail_addresses(owner_user_id, lifecycle_status, domain_id, email);
CREATE INDEX idx_mail_addresses_domain_lifecycle
  ON mail_addresses(domain_id, lifecycle_status, email);
CREATE INDEX idx_mail_addresses_routing_state
  ON mail_addresses(routing_state, updated_at);
CREATE UNIQUE INDEX idx_mail_addresses_default_sender
  ON mail_addresses(owner_user_id)
  WHERE is_default_sender = 1 AND lifecycle_status = 'active' AND send_enabled = 1;

-- Historical recipients and senders deliberately remain unmapped. A separate
-- dry-run and explicit configuration step must resolve their identity.
ALTER TABLE email_messages ADD COLUMN mail_domain_id TEXT;
ALTER TABLE email_messages ADD COLUMN mail_address_id TEXT;
ALTER TABLE email_messages ADD COLUMN recipient_status TEXT NOT NULL DEFAULT 'legacy-unmapped'
  CHECK (recipient_status IN ('managed', 'unregistered', 'legacy-unmapped'));
ALTER TABLE workspace_messages ADD COLUMN sender_address_id TEXT;
ALTER TABLE workspace_messages ADD COLUMN recipient_address_id TEXT;
ALTER TABLE workspace_messages ADD COLUMN reply_to_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspace_drafts ADD COLUMN sender_address_id TEXT;
ALTER TABLE workspace_drafts ADD COLUMN from_name TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_drafts ADD COLUMN from_email TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_drafts ADD COLUMN reply_to_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspace_search_documents ADD COLUMN mail_address_id TEXT;

CREATE INDEX idx_email_messages_owner_address_cursor
  ON email_messages(owner_user_id, mail_address_id, "timestamp" DESC, id DESC);
CREATE INDEX idx_workspace_messages_owner_sender_cursor
  ON workspace_messages(user_id, sender_address_id, sent_at DESC, id DESC);
CREATE INDEX idx_workspace_messages_owner_recipient_cursor
  ON workspace_messages(user_id, recipient_address_id, sent_at DESC, id DESC);
CREATE INDEX idx_workspace_drafts_owner_sender_cursor
  ON workspace_drafts(user_id, sender_address_id, updated_at DESC, id DESC);
CREATE INDEX idx_workspace_search_documents_address
  ON workspace_search_documents(user_id, mail_address_id, entity_kind, entity_id);

DROP TRIGGER email_messages_search_ai;
DROP TRIGGER email_messages_search_au;
DROP TRIGGER workspace_messages_search_ai;
DROP TRIGGER workspace_messages_search_au;
DROP TRIGGER workspace_drafts_search_ai;
DROP TRIGGER workspace_drafts_search_au;

CREATE TRIGGER email_messages_search_ai AFTER INSERT ON email_messages WHEN new.owner_user_id IS NOT NULL BEGIN
  INSERT INTO workspace_search_documents
    (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at, mail_address_id)
  VALUES (
    new.owner_user_id, 'inbound', new.id,
    substr(new."from", 1, 2048),
    substr(new."to" || ' ' || new.to_json, 1, 4096),
    substr(new.cc || ' ' || new.cc_json, 1, 4096),
    substr(new.subject, 1, 1024),
    substr(CASE WHEN new.text_body <> '' THEN new.text_body ELSE new.snippet END, 1, 16384),
    'Inbound Cloudflare',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    new.mail_address_id
  );
END;

CREATE TRIGGER email_messages_search_au
AFTER UPDATE OF owner_user_id, "from", "to", to_json, cc, cc_json, subject, text_body, snippet, mail_address_id ON email_messages BEGIN
  DELETE FROM workspace_search_documents WHERE entity_kind = 'inbound' AND entity_id = old.id;
  INSERT INTO workspace_search_documents
    (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at, mail_address_id)
  SELECT
    new.owner_user_id, 'inbound', new.id,
    substr(new."from", 1, 2048),
    substr(new."to" || ' ' || new.to_json, 1, 4096),
    substr(new.cc || ' ' || new.cc_json, 1, 4096),
    substr(new.subject, 1, 1024),
    substr(CASE WHEN new.text_body <> '' THEN new.text_body ELSE new.snippet END, 1, 16384),
    'Inbound Cloudflare',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    new.mail_address_id
  WHERE new.owner_user_id IS NOT NULL;
END;

CREATE TRIGGER workspace_messages_search_ai AFTER INSERT ON workspace_messages BEGIN
  INSERT INTO workspace_search_documents
    (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at, mail_address_id)
  VALUES (
    new.user_id, 'message', new.id,
    substr(new.from_name || ' ' || new.from_email, 1, 2048),
    substr(new.to_name || ' ' || new.to_email || ' ' || new.to_json, 1, 4096),
    substr(new.cc || ' ' || new.cc_json, 1, 4096),
    substr(new.subject, 1, 1024),
    substr(CASE WHEN new.text_body <> '' THEN new.text_body WHEN new.body <> '' THEN new.body ELSE new.preview END, 1, 16384),
    substr(new.labels_json, 1, 4096),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    CASE WHEN new.folder = 'sent' THEN new.sender_address_id ELSE new.recipient_address_id END
  );
END;

CREATE TRIGGER workspace_messages_search_au
AFTER UPDATE OF user_id, from_name, from_email, to_name, to_email, to_json, cc, cc_json, subject, text_body, body, preview, labels_json, sender_address_id, recipient_address_id, folder ON workspace_messages BEGIN
  DELETE FROM workspace_search_documents WHERE entity_kind = 'message' AND entity_id = old.id;
  INSERT INTO workspace_search_documents
    (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at, mail_address_id)
  VALUES (
    new.user_id, 'message', new.id,
    substr(new.from_name || ' ' || new.from_email, 1, 2048),
    substr(new.to_name || ' ' || new.to_email || ' ' || new.to_json, 1, 4096),
    substr(new.cc || ' ' || new.cc_json, 1, 4096),
    substr(new.subject, 1, 1024),
    substr(CASE WHEN new.text_body <> '' THEN new.text_body WHEN new.body <> '' THEN new.body ELSE new.preview END, 1, 16384),
    substr(new.labels_json, 1, 4096),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    CASE WHEN new.folder = 'sent' THEN new.sender_address_id ELSE new.recipient_address_id END
  );
END;

CREATE TRIGGER workspace_drafts_search_ai AFTER INSERT ON workspace_drafts BEGIN
  INSERT INTO workspace_search_documents
    (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at, mail_address_id)
  VALUES (
    new.user_id, 'draft', new.id,
    substr(new.from_name || ' ' || new.from_email, 1, 2048),
    substr(new.to_email || ' ' || new.to_json, 1, 4096),
    substr(new.cc || ' ' || new.cc_json, 1, 4096),
    substr(new.subject, 1, 1024),
    substr(new.body, 1, 16384),
    'Draft',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    new.sender_address_id
  );
END;

CREATE TRIGGER workspace_drafts_search_au
AFTER UPDATE OF user_id, to_email, to_json, cc, cc_json, subject, body, sender_address_id, from_name, from_email ON workspace_drafts BEGIN
  DELETE FROM workspace_search_documents WHERE entity_kind = 'draft' AND entity_id = old.id;
  INSERT INTO workspace_search_documents
    (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at, mail_address_id)
  VALUES (
    new.user_id, 'draft', new.id,
    substr(new.from_name || ' ' || new.from_email, 1, 2048),
    substr(new.to_email || ' ' || new.to_json, 1, 4096),
    substr(new.cc || ' ' || new.cc_json, 1, 4096),
    substr(new.subject, 1, 1024),
    substr(new.body, 1, 16384),
    'Draft',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    new.sender_address_id
  );
END;

INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
VALUES ('flaremail', 24, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(schema_name) DO UPDATE SET schema_version = excluded.schema_version, updated_at = excluded.updated_at;
