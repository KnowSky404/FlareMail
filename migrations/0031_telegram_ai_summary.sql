ALTER TABLE workspace_telegram_bindings ADD COLUMN ai_summary_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ai_summary_enabled IN (0, 1));
ALTER TABLE workspace_telegram_deliveries ADD COLUMN ai_summary_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ai_summary_enabled IN (0, 1));
ALTER TABLE workspace_telegram_deliveries ADD COLUMN ai_attempted INTEGER NOT NULL DEFAULT 0 CHECK (ai_attempted IN (0, 1));

UPDATE workspace_schema_metadata SET schema_version = 31,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE schema_name = 'flaremail';
