-- Canonical recipient arrays for compose, drafts and sent messages.
-- Legacy text columns remain readable for old clients and old rows.
ALTER TABLE workspace_messages ADD COLUMN to_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspace_messages ADD COLUMN cc_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspace_messages ADD COLUMN bcc_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspace_drafts ADD COLUMN to_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspace_drafts ADD COLUMN cc_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspace_drafts ADD COLUMN bcc_json TEXT NOT NULL DEFAULT '[]';

UPDATE workspace_messages
SET to_json = json_array(json_object('name', '', 'email', lower(trim(to_email))))
WHERE trim(to_email) <> '' AND (to_json = '[]' OR to_json IS NULL);

UPDATE workspace_drafts
SET to_json = json_array(json_object('name', '', 'email', lower(trim(to_email))))
WHERE trim(to_email) <> '' AND (to_json = '[]' OR to_json IS NULL);

INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
VALUES ('flaremail', 11, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(schema_name) DO UPDATE SET schema_version = excluded.schema_version, updated_at = excluded.updated_at;
