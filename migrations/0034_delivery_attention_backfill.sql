-- A sent event on the same attempt does not clear an earlier delivery delay.
INSERT INTO workspace_delivery_attention (user_id, message_id, attempt_number, kind, eligible_at)
SELECT s.user_id, s.message_id, s.attempts, 'delayed',
  MIN(MIN(strftime('%Y-%m-%dT%H:%M:%fZ', e.event_created_at)), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM workspace_delivery_statuses s
JOIN workspace_messages m ON m.id = s.message_id AND m.user_id = s.user_id AND m.folder = 'sent'
LEFT JOIN workspace_delivery_attempts a ON a.message_id = s.message_id AND a.user_id = s.user_id
  AND a.attempt_number = s.attempts
JOIN workspace_outbound_events e ON e.message_id = s.message_id AND e.user_id = s.user_id
  AND e.provider_message_id = s.provider_message_id AND e.event_type = 'email.delivery_delayed'
WHERE s.status = 'sent' AND s.last_event = 'email.sent'
  AND e.event_created_at <= s.last_event_at
  AND e.event_created_at >= COALESCE(
    CASE WHEN EXISTS (
      SELECT 1 FROM workspace_delivery_attempts prior
      WHERE prior.message_id = a.message_id AND prior.user_id = a.user_id
        AND prior.attempt_number < a.attempt_number AND prior.provider_message_id = a.provider_message_id
    ) THEN COALESCE(a.completed_at, a.started_at) ELSE a.started_at END,
    s.submitted_at, s.created_at
  )
  AND (a.provider_message_id = s.provider_message_id OR (a.id IS NULL AND s.attempts <= 1))
  AND strftime('%Y-%m-%dT%H:%M:%fZ', e.event_created_at) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM workspace_delivery_attention existing
    WHERE existing.message_id = s.message_id AND existing.user_id = s.user_id
      AND (existing.closed_at IS NULL OR (existing.attempt_number = s.attempts AND existing.kind = 'delayed'))
  )
GROUP BY s.user_id, s.message_id, s.attempts;

UPDATE workspace_schema_metadata SET schema_version = 34,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE schema_name = 'flaremail';
