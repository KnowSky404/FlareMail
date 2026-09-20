-- Separate the stable mail owner from the credential used to access it.
-- Legacy owner IDs and every owner-scoped mail/R2 reference stay intact.
DROP TRIGGER workspace_users_telegram_delete_cleanup;

CREATE TABLE workspace_auth_credentials (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE
    CHECK (length(trim(username)) BETWEEN 1 AND 128),
  credential_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Preserve a unique legacy login as a username. Ambiguous case-folded
-- duplicates are omitted and appear in the migration dry-run report.
INSERT INTO workspace_auth_credentials (user_id, username, credential_hash, updated_at)
SELECT u.id, u.login_email, u.credential_hash, COALESCE(u.credential_updated_at, u.updated_at)
FROM workspace_users AS u
WHERE u.login_email IS NOT NULL
  AND u.credential_hash IS NOT NULL
  AND length(trim(u.login_email)) BETWEEN 1 AND 128
  AND (SELECT COUNT(*) FROM workspace_users AS candidate
    WHERE lower(candidate.login_email) = lower(u.login_email)) = 1;

CREATE TABLE workspace_users_next (
  id TEXT PRIMARY KEY,
  login_email TEXT UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  forwarding_enabled INTEGER NOT NULL DEFAULT 1,
  signature TEXT NOT NULL DEFAULT '',
  incoming_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO workspace_users_next (
  id, login_email, name, role, email, company, location, timezone,
  forwarding_enabled, signature, incoming_sequence, created_at, updated_at
)
SELECT
  id, login_email, name, role, email, company, location, timezone,
  forwarding_enabled, signature, incoming_sequence, created_at, updated_at
FROM workspace_users;

DROP TABLE workspace_users;
ALTER TABLE workspace_users_next RENAME TO workspace_users;

CREATE TABLE workspace_owner (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  user_id TEXT NOT NULL UNIQUE
);

-- Auto-select only a provably single-owner legacy installation. Multiple
-- historical users require an explicit operator choice; their data is never
-- merged or reassigned by this migration.
INSERT INTO workspace_owner (singleton, user_id)
SELECT 1, MIN(id)
FROM workspace_users
HAVING COUNT(*) = 1;

ALTER TABLE workspace_sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'local'
  CHECK (auth_method IN ('local', 'cloudflare-access'));
ALTER TABLE workspace_sessions ADD COLUMN principal_id TEXT;

CREATE INDEX idx_workspace_sessions_auth_principal
  ON workspace_sessions(auth_method, principal_id, expires_at);

CREATE TRIGGER workspace_users_telegram_delete_cleanup
AFTER DELETE ON workspace_users
BEGIN
  DELETE FROM workspace_telegram_delivery_limits
  WHERE scope = 'user:' || old.id
     OR scope IN (
       SELECT 'chat:' || telegram_chat_id
       FROM workspace_telegram_bindings
       WHERE user_id = old.id AND telegram_chat_id IS NOT NULL
     );

  UPDATE workspace_telegram_bind_challenges
  SET status = CASE WHEN status = 'pending' THEN 'replaced' ELSE status END,
      replaced_at = CASE WHEN status = 'pending' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE replaced_at END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE owner_user_id = old.id AND status = 'pending';

  UPDATE workspace_telegram_deliveries
  SET status = 'cancelled', claim_token = NULL, lease_expires_at = NULL,
      completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE owner_user_id = old.id
    AND status IN ('pending', 'retryable', 'processing')
    AND external_started = 0;

  UPDATE workspace_telegram_bindings
  SET state = 'revoked', enabled = 0, telegram_user_id = NULL, telegram_chat_id = NULL,
      telegram_username = NULL, telegram_display_name = '', candidate_challenge_id = NULL,
      candidate_expires_at = NULL, authorization_version = authorization_version + 1,
      revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE user_id = old.id;

  DELETE FROM workspace_telegram_rate_limits WHERE user_id = old.id;
END;

INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
VALUES ('flaremail', 23, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(schema_name) DO UPDATE SET schema_version = excluded.schema_version, updated_at = excluded.updated_at;
