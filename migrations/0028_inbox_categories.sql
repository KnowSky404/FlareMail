-- NULL keeps automatic metadata classification; a value records the Owner's choice.
ALTER TABLE workspace_messages ADD COLUMN inbox_category TEXT
  CHECK (inbox_category IS NULL OR inbox_category IN ('primary', 'promotions', 'social', 'updates', 'forums'));
ALTER TABLE email_messages ADD COLUMN inbox_category TEXT
  CHECK (inbox_category IS NULL OR inbox_category IN ('primary', 'promotions', 'social', 'updates', 'forums'));

UPDATE workspace_schema_metadata
SET schema_version = 28, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE schema_name = 'flaremail';
