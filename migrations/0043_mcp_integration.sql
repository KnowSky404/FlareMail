CREATE TABLE mcp_policies (
  owner_id TEXT PRIMARY KEY REFERENCES workspace_users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  scopes INTEGER NOT NULL DEFAULT 3 CHECK (scopes BETWEEN 0 AND 7),
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE mcp_grants (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES workspace_users(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  scopes INTEGER NOT NULL CHECK (scopes BETWEEN 0 AND 7),
  authorized_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  activated_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX mcp_grants_owner_time ON mcp_grants(owner_id, authorized_at DESC, id DESC);
CREATE INDEX mcp_grants_expiry ON mcp_grants(expires_at);
CREATE INDEX mcp_grants_revocation ON mcp_grants(revoked_at) WHERE revoked_at IS NOT NULL;

CREATE TABLE mcp_credentials (
  digest TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('code', 'access', 'refresh')),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX mcp_credentials_grant ON mcp_credentials(grant_id);
CREATE INDEX mcp_credentials_expiry ON mcp_credentials(expires_at);

CREATE TABLE mcp_activity (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES workspace_users(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  tool TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'denied', 'invalid_input', 'not_found', 'limited', 'unavailable')),
  duration_ms INTEGER NOT NULL,
  called_at INTEGER NOT NULL
);
CREATE INDEX mcp_activity_owner_time ON mcp_activity(owner_id, called_at DESC, id DESC);
CREATE INDEX mcp_activity_expiry ON mcp_activity(called_at);

CREATE TABLE mcp_consent_nonces (
  digest TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES workspace_users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX mcp_consent_expiry ON mcp_consent_nonces(expires_at);

UPDATE workspace_schema_metadata SET schema_version = 43,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE schema_name = 'flaremail';
