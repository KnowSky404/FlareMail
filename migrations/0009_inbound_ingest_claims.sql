-- Reserve an inbound dedupe key before any R2 write. A lease token makes
-- stale recovery safe: a recovered invocation gets a new storage id and
-- cannot finalize or clean up another invocation's objects.
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

INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
VALUES ('flaremail', 9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(schema_name) DO UPDATE SET schema_version = excluded.schema_version, updated_at = excluded.updated_at;
