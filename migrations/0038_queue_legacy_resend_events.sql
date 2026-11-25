-- Recover webhooks that arrived before legacy sends saved their provider IDs.
UPDATE workspace_outbound_events AS event
SET message_id = delivery.message_id, user_id = delivery.user_id,
  payload_json = json_set(payload_json, '$._flaremailDeferred', 1)
FROM workspace_delivery_statuses AS delivery
WHERE event.provider = 'resend' AND event.user_id = 'unmatched'
  AND event.provider_message_id = delivery.provider_message_id
  AND CASE WHEN json_valid(event.payload_json)
    THEN json_extract(event.payload_json, '$.data.email_id') = event.provider_message_id
    ELSE 0 END;

UPDATE workspace_schema_metadata SET schema_version = 38,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE schema_name = 'flaremail';
