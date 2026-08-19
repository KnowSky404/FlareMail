-- Bounded, structured inbound addressing and technical metadata. The raw
-- RFC822 object remains the lossless source of truth in R2.
ALTER TABLE email_messages ADD COLUMN to_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE email_messages ADD COLUMN cc_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE email_messages ADD COLUMN reply_to_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE email_messages ADD COLUMN return_path TEXT;
ALTER TABLE email_messages ADD COLUMN delivered_to TEXT;
ALTER TABLE email_messages ADD COLUMN headers_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE email_messages ADD COLUMN authentication_results_json TEXT NOT NULL DEFAULT '[]';

UPDATE email_messages
SET to_json = json_array(json_object('name', '', 'email', lower(trim("to"))))
WHERE trim("to") <> '' AND (to_json = '[]' OR to_json IS NULL);

INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
VALUES ('flaremail', 14, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(schema_name) DO UPDATE SET schema_version = excluded.schema_version, updated_at = excluded.updated_at;
