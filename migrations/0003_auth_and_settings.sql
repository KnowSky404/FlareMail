-- Authentication and per-user settings.
-- Legacy users/sessions remain valid rows. Secret-derived hashes are nullable
-- so an operator can bootstrap credentials explicitly after this migration;
-- no password or token is fabricated during migration.

ALTER TABLE workspace_users ADD COLUMN credential_hash TEXT;
ALTER TABLE workspace_users ADD COLUMN credential_salt TEXT;
ALTER TABLE workspace_users ADD COLUMN credential_iterations INTEGER;
ALTER TABLE workspace_users ADD COLUMN credential_updated_at TEXT;

ALTER TABLE workspace_sessions ADD COLUMN token_hash TEXT;
ALTER TABLE workspace_sessions ADD COLUMN expires_at TEXT;
ALTER TABLE workspace_sessions ADD COLUMN revoked_at TEXT;
ALTER TABLE workspace_sessions ADD COLUMN last_seen_at TEXT;

-- Existing sessions get a bounded compatibility lifetime derived from their
-- last activity. A null token_hash intentionally prevents old plaintext/id
-- cookies from being treated as secure session tokens by new readers.
UPDATE workspace_sessions
SET expires_at = datetime(updated_at, '+30 days'),
    last_seen_at = updated_at
WHERE expires_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_sessions_token_hash
  ON workspace_sessions(token_hash)
  WHERE token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_sessions_expires_at
  ON workspace_sessions(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_settings (
  user_id TEXT PRIMARY KEY,
  theme TEXT NOT NULL DEFAULT 'system'
    CHECK (theme IN ('light', 'dark', 'system')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The user id is the stable settings key, so this backfill is repeatable and
-- cannot multiply rows when an operator replays a failed deployment step.
INSERT INTO workspace_settings (user_id, theme, settings_json, created_at, updated_at)
SELECT id, 'system', '{}', created_at, updated_at
FROM workspace_users AS u
WHERE NOT EXISTS (
  SELECT 1 FROM workspace_settings AS s WHERE s.user_id = u.id
);

CREATE INDEX IF NOT EXISTS idx_workspace_settings_theme
  ON workspace_settings(theme);
