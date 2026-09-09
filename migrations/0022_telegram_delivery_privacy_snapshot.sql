-- Preserve the least-privileged notification shape selected when a mail is
-- enqueued. The dispatcher may apply stricter current settings, but a queued
-- row can never gain a summary that was not enabled when it was created.
ALTER TABLE workspace_telegram_deliveries ADD COLUMN privacy_mode INTEGER NOT NULL DEFAULT 0 CHECK (privacy_mode IN (0, 1));
ALTER TABLE workspace_telegram_deliveries ADD COLUMN summary_enabled INTEGER NOT NULL DEFAULT 0 CHECK (summary_enabled IN (0, 1));

INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
VALUES ('flaremail', 22, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(schema_name) DO UPDATE SET schema_version = excluded.schema_version, updated_at = excluded.updated_at;
