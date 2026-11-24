-- Limit deferred-event maintenance to the pending subset of the event ledger.
CREATE INDEX idx_workspace_outbound_events_pending_resend
  ON workspace_outbound_events(event_created_at, provider_message_id)
  WHERE provider = 'resend' AND provider_message_id IS NOT NULL AND (
    CASE WHEN json_valid(payload_json)
      THEN COALESCE(json_extract(payload_json, '$._flaremailDeferred') = 1, 0) ELSE 0 END
  );

-- Legacy same-ID acceptance could overwrite a delay recorded while the retry was in flight.
INSERT INTO workspace_delivery_attention (user_id, message_id, attempt_number, kind, eligible_at, delayed_provider_message_id)
SELECT s.user_id, s.message_id, s.attempts, 'delayed',
  MIN(MIN(strftime('%Y-%m-%dT%H:%M:%fZ', e.event_created_at)), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  s.provider_message_id
FROM workspace_delivery_statuses s
JOIN workspace_messages m ON m.id = s.message_id AND m.user_id = s.user_id AND m.folder = 'sent'
JOIN workspace_delivery_attempts latest ON latest.message_id = s.message_id AND latest.user_id = s.user_id
  AND latest.attempt_number = s.attempts AND latest.provider_message_id = s.provider_message_id
JOIN workspace_outbound_events acceptance ON acceptance.svix_id = 'local:' || s.message_id || ':submission:' || s.attempts
  AND acceptance.message_id = s.message_id AND acceptance.user_id = s.user_id
  AND acceptance.provider_message_id = s.provider_message_id AND acceptance.event_type = 'submission'
JOIN workspace_outbound_events e ON e.message_id = s.message_id AND e.user_id = s.user_id
  AND e.provider_message_id = s.provider_message_id AND e.provider = 'resend' AND e.event_type = 'email.delivery_delayed'
WHERE s.status = 'submitted' AND s.last_event = 'submission' AND latest.status = 'submitted'
  AND e.rowid < acceptance.rowid
  AND julianday(e.event_created_at) BETWEEN julianday(latest.started_at) AND julianday(acceptance.event_created_at)
  AND s.provider_message_id = (
    SELECT prior.provider_message_id FROM workspace_delivery_attempts prior
    WHERE prior.message_id = s.message_id AND prior.user_id = s.user_id
      AND prior.attempt_number < s.attempts AND prior.provider_message_id IS NOT NULL
    ORDER BY prior.attempt_number DESC LIMIT 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM workspace_outbound_events outcome
    WHERE outcome.message_id = e.message_id AND outcome.user_id = e.user_id
      AND outcome.provider_message_id = e.provider_message_id AND (
        (outcome.event_type IN ('email.delivered', 'email.bounced', 'email.failed', 'email.complained', 'email.suppressed')
          AND julianday(outcome.event_created_at) >= julianday(e.event_created_at))
        OR (outcome.event_type = 'email.sent' AND outcome.rowid < e.rowid
          AND julianday(outcome.event_created_at) > julianday(e.event_created_at))
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM workspace_delivery_attention existing
    WHERE existing.message_id = s.message_id AND existing.user_id = s.user_id AND existing.kind = 'delayed'
      AND (existing.delayed_provider_message_id = s.provider_message_id OR existing.attempt_number = s.attempts)
  )
GROUP BY s.user_id, s.message_id, s.attempts;

UPDATE workspace_schema_metadata SET schema_version = 36,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE schema_name = 'flaremail';
