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

-- Migration backfill. These INSERT statements fire the FTS synchronization
-- trigger, so the projection and virtual table become usable atomically with
-- the schema version bump.
INSERT INTO workspace_search_documents
  (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at)
SELECT
  owner_user_id, 'inbound', id,
  substr("from", 1, 2048),
  substr("to" || ' ' || to_json, 1, 4096),
  substr(cc || ' ' || cc_json, 1, 4096),
  substr(subject, 1, 1024),
  substr(CASE WHEN text_body <> '' THEN text_body ELSE snippet END, 1, 16384),
  'Inbound Cloudflare',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM email_messages
WHERE owner_user_id IS NOT NULL;

INSERT INTO workspace_search_documents
  (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at)
SELECT
  user_id, 'message', id,
  substr(from_name || ' ' || from_email, 1, 2048),
  substr(to_name || ' ' || to_email || ' ' || to_json, 1, 4096),
  substr(cc || ' ' || cc_json, 1, 4096),
  substr(subject, 1, 1024),
  substr(CASE WHEN text_body <> '' THEN text_body WHEN body <> '' THEN body ELSE preview END, 1, 16384),
  substr(labels_json, 1, 4096),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM workspace_messages;

INSERT INTO workspace_search_documents
  (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at)
SELECT
  user_id, 'draft', id, '',
  substr(to_email || ' ' || to_json, 1, 4096),
  substr(cc || ' ' || cc_json, 1, 4096),
  substr(subject, 1, 1024),
  substr(body, 1, 16384),
  'Draft',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM workspace_drafts;

INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
VALUES ('flaremail', 15, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(schema_name) DO UPDATE SET schema_version = excluded.schema_version, updated_at = excluded.updated_at;
