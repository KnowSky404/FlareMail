ALTER TABLE mail_addresses ADD COLUMN delete_route_policy TEXT
  CHECK (delete_route_policy IS NULL OR delete_route_policy IN (
    'remove_owned_route', 'retain_reject_route', 'preserve_imported_route'
  ));

INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
VALUES ('flaremail', 26, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(schema_name) DO UPDATE SET schema_version = excluded.schema_version, updated_at = excluded.updated_at;
