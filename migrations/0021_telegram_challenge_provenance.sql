-- Tie a consumed binding challenge to the webhook update that consumed it.
-- This keeps bound/conflict/invalid update finalization deterministic inside
-- the same D1 batch, even when two updates arrive in the same time slice.
ALTER TABLE workspace_telegram_bind_challenges ADD COLUMN consumed_update_id TEXT;

INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
VALUES ('flaremail', 21, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(schema_name) DO UPDATE SET schema_version = excluded.schema_version, updated_at = excluded.updated_at;
