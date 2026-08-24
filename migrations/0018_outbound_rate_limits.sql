-- Durable per-user application-layer send rate-limit state. The counter is
-- deliberately independent from message content, recipients, and provider
-- delivery state so rejected sends do not create or expose mail data.
CREATE TABLE workspace_outbound_rate_limits (
  user_id TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  window_started_at INTEGER NOT NULL,
  reset_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_workspace_outbound_rate_limits_reset_at
  ON workspace_outbound_rate_limits(reset_at);

INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
VALUES ('flaremail', 18, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(schema_name) DO UPDATE SET schema_version = excluded.schema_version, updated_at = excluded.updated_at;
