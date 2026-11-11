CREATE TABLE mail_ai_analyses (
  owner_user_id TEXT NOT NULL,
  message_kind TEXT NOT NULL CHECK (message_kind IN ('inbound', 'workspace')),
  message_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  model TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed')),
  result_json TEXT,
  claim_token TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, message_kind, message_id)
);

CREATE TABLE mail_ai_rate_limits (
  owner_user_id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE TRIGGER mail_ai_workspace_delete AFTER DELETE ON workspace_messages BEGIN
  DELETE FROM mail_ai_analyses WHERE owner_user_id = old.user_id AND message_kind = 'workspace' AND message_id = old.id;
END;
CREATE TRIGGER mail_ai_inbound_delete AFTER DELETE ON email_messages BEGIN
  DELETE FROM mail_ai_analyses WHERE owner_user_id = old.owner_user_id AND message_kind = 'inbound' AND message_id = old.id;
END;
CREATE TRIGGER mail_ai_owner_delete AFTER DELETE ON workspace_users BEGIN
  DELETE FROM mail_ai_analyses WHERE owner_user_id = old.id;
  DELETE FROM mail_ai_rate_limits WHERE owner_user_id = old.id;
END;

UPDATE workspace_schema_metadata SET schema_version = 30,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE schema_name = 'flaremail';
