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

  -- Keep the previous issue actionable until its retry stalls or actually progresses.
  UPDATE workspace_delivery_attention
  SET state = 'superseded', closed_at = (
    SELECT stale.eligible_at FROM workspace_delivery_attention stale
    WHERE stale.message_id = new.message_id AND stale.user_id = new.user_id
      AND stale.kind = 'stale_submitting' AND stale.closed_at IS NULL
      AND stale.id > workspace_delivery_attention.id
      AND stale.eligible_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ORDER BY stale.id LIMIT 1
  )
  WHERE message_id = new.message_id AND user_id = new.user_id AND closed_at IS NULL
    AND EXISTS (
      SELECT 1 FROM workspace_delivery_attention stale
      WHERE stale.message_id = new.message_id AND stale.user_id = new.user_id
        AND stale.kind = 'stale_submitting' AND stale.closed_at IS NULL
        AND stale.id > workspace_delivery_attention.id
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

UPDATE workspace_schema_metadata SET schema_version = 35,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE schema_name = 'flaremail';
