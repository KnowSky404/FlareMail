-- Replay definitive failures that a legacy same-ID acceptance could overwrite.
WITH masked_failures AS (
  SELECT (
    SELECT failure.rowid FROM workspace_outbound_events failure
    WHERE failure.message_id = delivery.message_id AND failure.user_id = delivery.user_id
      AND failure.provider = 'resend' AND failure.provider_message_id = delivery.provider_message_id
      AND failure.event_type = 'email.failed' AND failure.rowid < acceptance.rowid
      AND julianday(failure.event_created_at) IS NOT NULL
      AND CASE WHEN json_valid(failure.payload_json)
        THEN json_extract(failure.payload_json, '$.type') = 'email.failed'
          AND json_extract(failure.payload_json, '$.data.email_id') = failure.provider_message_id
          AND julianday(json_extract(failure.payload_json, '$.created_at')) = julianday(failure.event_created_at)
        ELSE 0 END
    ORDER BY julianday(failure.event_created_at) DESC, failure.rowid DESC LIMIT 1
  ) AS failure_row
  FROM workspace_delivery_statuses delivery
  JOIN workspace_delivery_attempts latest ON latest.message_id = delivery.message_id AND latest.user_id = delivery.user_id
    AND latest.attempt_number = delivery.attempts AND latest.provider_message_id = delivery.provider_message_id
  JOIN workspace_outbound_events acceptance ON acceptance.svix_id = 'local:' || delivery.message_id || ':submission:' || delivery.attempts
    AND acceptance.message_id = delivery.message_id AND acceptance.user_id = delivery.user_id
    AND acceptance.provider_message_id = delivery.provider_message_id AND acceptance.event_type = 'submission'
  WHERE delivery.provider = 'resend' AND delivery.status IN ('submitted', 'sent', 'delayed') AND latest.status = 'submitted'
    AND delivery.provider_message_id = (
      SELECT prior.provider_message_id FROM workspace_delivery_attempts prior
      WHERE prior.message_id = delivery.message_id AND prior.user_id = delivery.user_id
        AND prior.attempt_number < delivery.attempts AND prior.provider_message_id IS NOT NULL
      ORDER BY prior.attempt_number DESC LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM workspace_outbound_events outcome
      WHERE outcome.message_id = delivery.message_id AND outcome.user_id = delivery.user_id
        AND outcome.provider = 'resend' AND outcome.provider_message_id = delivery.provider_message_id
        AND outcome.event_type IN ('email.delivered', 'email.bounced', 'email.complained', 'email.suppressed')
    )
)
UPDATE workspace_outbound_events SET payload_json = json_set(payload_json, '$._flaremailDeferred', 1)
WHERE rowid IN (SELECT failure_row FROM masked_failures WHERE failure_row IS NOT NULL);

UPDATE workspace_schema_metadata SET schema_version = 39,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE schema_name = 'flaremail';
