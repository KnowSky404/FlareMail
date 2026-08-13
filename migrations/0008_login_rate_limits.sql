CREATE TABLE IF NOT EXISTS workspace_login_rate_limits (
  identity_hash TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  window_started_at INTEGER NOT NULL,
  reset_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_login_rate_limits_reset_at
  ON workspace_login_rate_limits(reset_at);
