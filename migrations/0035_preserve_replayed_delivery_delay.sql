-- A replayed acceptance for the same provider message does not clear its delivery delay.
DROP TRIGGER workspace_delivery_attention_status_update;

CREATE TRIGGER workspace_delivery_attention_status_update
AFTER UPDATE OF status, attempts, last_event_at ON workspace_delivery_statuses
WHEN new.status <> old.status OR new.attempts <> old.attempts
  OR (new.status = 'submitting' AND new.last_event_at IS NOT old.last_event_at) BEGIN
  -- Submission timestamps can move within the same attempt before it becomes stale.
  UPDATE workspace_delivery_attention
  SET eligible_at = COALESCE((SELECT eligible_at FROM workspace_delivery_attention_source WHERE message_id = new.message_id), eligible_at)
  WHERE message_id = new.message_id AND user_id = new.user_id AND closed_at IS NULL
    AND kind = 'stale_submitting' AND attempt_number = new.attempts
    AND new.status = 'submitting' AND old.status = 'submitting' AND old.attempts = new.attempts
    AND eligible_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

  DELETE FROM workspace_delivery_attention
  WHERE message_id = new.message_id AND user_id = new.user_id AND closed_at IS NULL
    AND kind = 'stale_submitting' AND (new.status <> 'submitting' OR attempt_number <> new.attempts)
    AND eligible_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

  -- A stalled retry temporarily shadows a delay for the still-current provider ID.
  UPDATE workspace_delivery_attention_clock SET version = version + 1
  WHERE singleton = 1 AND new.status IN ('submitted', 'sent')
    AND old.provider_message_id IS NOT NULL AND new.provider_message_id IS old.provider_message_id
    AND EXISTS (
      SELECT 1 FROM workspace_delivery_attention delay JOIN workspace_delivery_attention stale
        ON stale.message_id = delay.message_id AND stale.user_id = delay.user_id AND stale.attempt_number > delay.attempt_number
      WHERE delay.message_id = new.message_id AND delay.user_id = new.user_id
        AND delay.kind = 'delayed' AND delay.closed_at IS NULL
        AND stale.kind = 'stale_submitting' AND stale.closed_at IS NULL
        AND stale.eligible_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    );

  UPDATE workspace_delivery_attention
  SET version = (SELECT version FROM workspace_delivery_attention_clock WHERE singleton = 1)
  WHERE message_id = new.message_id AND user_id = new.user_id AND closed_at IS NULL AND kind = 'delayed'
    AND new.status IN ('submitted', 'sent')
    AND old.provider_message_id IS NOT NULL AND new.provider_message_id IS old.provider_message_id
    AND EXISTS (
      SELECT 1 FROM workspace_delivery_attention stale
      WHERE stale.message_id = new.message_id AND stale.user_id = new.user_id
        AND stale.kind = 'stale_submitting' AND stale.closed_at IS NULL
        AND stale.attempt_number > workspace_delivery_attention.attempt_number
        AND stale.eligible_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    );

  -- Keep the previous issue actionable until its retry stalls or actually progresses.
  UPDATE workspace_delivery_attention
  SET state = 'superseded', closed_at = (
    SELECT stale.eligible_at FROM workspace_delivery_attention stale
    WHERE stale.message_id = new.message_id AND stale.user_id = new.user_id
      AND stale.kind = 'stale_submitting' AND stale.closed_at IS NULL
      AND stale.attempt_number > workspace_delivery_attention.attempt_number
      AND stale.eligible_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ORDER BY stale.attempt_number LIMIT 1
  )
  WHERE message_id = new.message_id AND user_id = new.user_id AND closed_at IS NULL AND kind <> 'delayed'
    AND EXISTS (
      SELECT 1 FROM workspace_delivery_attention stale
      WHERE stale.message_id = new.message_id AND stale.user_id = new.user_id
        AND stale.kind = 'stale_submitting' AND stale.closed_at IS NULL
        AND stale.attempt_number > workspace_delivery_attention.attempt_number
        AND stale.eligible_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    );

  UPDATE workspace_delivery_attention
  SET state = CASE WHEN new.status IN ('submitted', 'sent', 'delivered')
    THEN 'resolved' ELSE 'superseded' END,
    closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE message_id = new.message_id AND user_id = new.user_id AND closed_at IS NULL AND (
    (new.status IN ('delayed', 'failed', 'bounced', 'complained', 'suppressed')
      AND (kind <> new.status OR attempt_number <> new.attempts))
    OR (new.status IN ('submitted', 'sent', 'delivered')
      AND NOT (kind = 'delayed' AND (
        (new.status = 'sent' AND attempt_number = new.attempts)
        OR (new.status IN ('submitted', 'sent') AND old.provider_message_id IS NOT NULL
          AND new.provider_message_id IS old.provider_message_id)
      )))
  );

  INSERT INTO workspace_delivery_attention (user_id, message_id, attempt_number, kind, eligible_at)
  SELECT src.user_id, src.message_id, src.attempt_number, src.kind, src.eligible_at
  FROM workspace_delivery_attention_source src
  WHERE src.message_id = new.message_id AND src.eligible_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM workspace_delivery_attention a
      WHERE a.message_id = src.message_id AND a.kind = src.kind
        AND a.attempt_number = src.attempt_number AND a.closed_at IS NULL
    );
END;

-- The previous migration starts at the latest acceptance; recover delays already known before a same-ID retry.
INSERT INTO workspace_delivery_attention (user_id, message_id, attempt_number, kind, eligible_at)
SELECT s.user_id, s.message_id, prior.attempt_number, 'delayed',
  MIN(MIN(strftime('%Y-%m-%dT%H:%M:%fZ', e.event_created_at)), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM workspace_delivery_statuses s
JOIN workspace_messages m ON m.id = s.message_id AND m.user_id = s.user_id AND m.folder = 'sent'
JOIN workspace_delivery_attempts latest ON latest.message_id = s.message_id AND latest.user_id = s.user_id
  AND latest.attempt_number = s.attempts AND (latest.provider_message_id = s.provider_message_id
    OR (s.status = 'submitting' AND latest.provider_message_id IS NULL))
JOIN workspace_delivery_attempts prior ON prior.message_id = s.message_id AND prior.user_id = s.user_id
  AND prior.provider_message_id = s.provider_message_id AND prior.attempt_number = (
    SELECT MIN(previous.attempt_number) FROM workspace_delivery_attempts previous
    WHERE previous.message_id = s.message_id AND previous.user_id = s.user_id
      AND previous.attempt_number < s.attempts AND previous.provider_message_id = s.provider_message_id
      AND NOT EXISTS (
        SELECT 1 FROM workspace_delivery_attempts replacement
        WHERE replacement.message_id = s.message_id AND replacement.user_id = s.user_id
          AND replacement.attempt_number > previous.attempt_number AND replacement.attempt_number < s.attempts
          AND replacement.provider_message_id IS NOT NULL AND replacement.provider_message_id <> s.provider_message_id
      )
  )
LEFT JOIN workspace_outbound_events submission
  ON submission.svix_id = 'local:' || s.message_id || ':submission:' || prior.attempt_number
  AND submission.provider_message_id = s.provider_message_id
JOIN workspace_outbound_events e ON e.message_id = s.message_id AND e.user_id = s.user_id
  AND e.provider_message_id = s.provider_message_id AND e.event_type = 'email.delivery_delayed'
WHERE s.status IN ('submitting', 'submitted', 'sent')
  AND e.event_created_at >= prior.started_at AND e.event_created_at <= latest.started_at
  AND strftime('%Y-%m-%dT%H:%M:%fZ', e.event_created_at) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM workspace_outbound_events outcome
    WHERE outcome.message_id = e.message_id AND outcome.user_id = e.user_id AND outcome.provider_message_id = e.provider_message_id
      AND outcome.event_created_at >= e.event_created_at AND (
        outcome.event_type IN ('email.delivered', 'email.bounced', 'email.failed', 'email.complained', 'email.suppressed')
        OR (outcome.event_type = 'email.sent' AND outcome.event_created_at > e.event_created_at
          AND outcome.rowid < e.rowid AND e.rowid > COALESCE(submission.rowid, 0))
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM workspace_delivery_attention existing
    WHERE existing.message_id = s.message_id AND existing.user_id = s.user_id AND existing.kind = 'delayed'
  )
GROUP BY s.user_id, s.message_id, prior.attempt_number;

UPDATE workspace_schema_metadata SET schema_version = 35,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE schema_name = 'flaremail';
