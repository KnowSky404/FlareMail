-- Limit deferred-event maintenance to the pending subset of the event ledger.
CREATE INDEX idx_workspace_outbound_events_pending_resend
  ON workspace_outbound_events(event_created_at, provider_message_id)
  WHERE provider = 'resend' AND provider_message_id IS NOT NULL AND (
    CASE WHEN json_valid(payload_json)
      THEN COALESCE(json_extract(payload_json, '$._flaremailDeferred') = 1, 0) ELSE 0 END
  );

UPDATE workspace_schema_metadata SET schema_version = 36,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE schema_name = 'flaremail';
