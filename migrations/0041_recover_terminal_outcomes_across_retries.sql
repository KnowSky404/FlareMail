-- Recover terminal outcomes hidden by a same-ID acceptance after an intervening unconfirmed retry.
WITH terminal_events AS (
  SELECT delivery.message_id, delivery.user_id, delivery.provider_message_id,
    delivery.status AS current_status, delivery.last_event AS current_event, delivery.last_event_at AS current_event_at,
    latest.started_at AS latest_started_at, acceptance.created_at AS accepted_at,
    e.rowid AS event_row, acceptance.rowid AS accepted_row, e.event_type, e.event_created_at, e.payload_json,
    COALESCE((
      SELECT attempt.attempt_number FROM workspace_delivery_attempts attempt
      WHERE attempt.message_id = delivery.message_id AND attempt.user_id = delivery.user_id
        AND attempt.attempt_number > prior.attempt_number AND attempt.attempt_number <= delivery.attempts
        AND julianday(attempt.started_at) < julianday(e.created_at)
      ORDER BY attempt.attempt_number DESC LIMIT 1
    ), prior.attempt_number) AS attempt_window, prior_acceptance.rowid AS prior_accepted_row
  FROM workspace_delivery_statuses delivery
  JOIN workspace_delivery_attempts latest ON latest.message_id = delivery.message_id AND latest.user_id = delivery.user_id
    AND latest.attempt_number = delivery.attempts AND latest.provider_message_id = delivery.provider_message_id
  JOIN workspace_delivery_attempts prior ON prior.message_id = delivery.message_id AND prior.user_id = delivery.user_id
    AND prior.provider = 'resend' AND prior.status = 'submitted'
    AND prior.provider_message_id = delivery.provider_message_id AND prior.attempt_number = (
      SELECT MAX(previous.attempt_number) FROM workspace_delivery_attempts previous
      WHERE previous.message_id = delivery.message_id AND previous.user_id = delivery.user_id
        AND previous.attempt_number < delivery.attempts AND previous.provider_message_id IS NOT NULL
    )
  JOIN workspace_outbound_events prior_acceptance
    ON prior_acceptance.svix_id = 'local:' || delivery.message_id || ':submission:' || prior.attempt_number
    AND prior_acceptance.message_id = delivery.message_id AND prior_acceptance.user_id = delivery.user_id
    AND prior_acceptance.provider = 'resend' AND prior_acceptance.provider_message_id = delivery.provider_message_id
    AND prior_acceptance.event_type = 'submission'
  JOIN workspace_outbound_events acceptance
    ON acceptance.svix_id = 'local:' || delivery.message_id || ':submission:' || delivery.attempts
    AND acceptance.message_id = delivery.message_id AND acceptance.user_id = delivery.user_id
    AND acceptance.provider = 'resend' AND acceptance.provider_message_id = delivery.provider_message_id
    AND acceptance.event_type = 'submission'
  JOIN workspace_outbound_events e ON e.message_id = delivery.message_id AND e.user_id = delivery.user_id
    AND e.provider = 'resend' AND e.provider_message_id = delivery.provider_message_id
    AND e.rowid > prior_acceptance.rowid AND e.rowid < acceptance.rowid
    AND e.event_type IN ('email.failed', 'email.delivered', 'email.bounced', 'email.complained', 'email.suppressed')
  WHERE delivery.provider = 'resend' AND latest.status = 'submitted'
    AND (delivery.status IN ('submitted', 'sent', 'delayed')
      OR (delivery.status = substr(e.event_type, 7) AND delivery.last_event = e.event_type))
    AND prior.attempt_number < delivery.attempts - 1
    AND NOT EXISTS (
      SELECT 1 FROM workspace_outbound_events later
      WHERE later.message_id = delivery.message_id AND later.user_id = delivery.user_id
        AND later.provider = 'resend' AND later.provider_message_id = delivery.provider_message_id
        AND later.rowid > acceptance.rowid
        AND later.event_type IN ('email.failed', 'email.delivered', 'email.bounced', 'email.complained', 'email.suppressed')
    )
),
-- A local failure is terminal. Later provider events still use the legacy terminal-state guard.
event_windows AS (
  SELECT event.*, COALESCE(reset.rowid, event.prior_accepted_row) AS reset_row,
    CASE WHEN reset.rowid IS NOT NULL AND json_extract(reset.payload_json, '$.status') = 'failed'
      AND (event.event_type <> 'email.failed' OR julianday(event.event_created_at) < julianday(reset.event_created_at))
      THEN 1 ELSE 0 END AS ignored_by_legacy
  FROM terminal_events event
  LEFT JOIN workspace_outbound_events reset
    ON reset.svix_id = 'local:' || event.message_id || ':submission:' || event.attempt_window
    AND reset.message_id = event.message_id AND reset.user_id = event.user_id AND reset.provider = 'resend'
    AND reset.event_type = 'submission' AND reset.provider_message_id IS NULL
    AND reset.rowid > event.prior_accepted_row AND reset.rowid < event.event_row
    AND CASE WHEN json_valid(reset.payload_json)
      THEN json_extract(reset.payload_json, '$.status') IN ('submitting', 'delayed', 'failed') ELSE 0 END
),
terminal_order AS (
  SELECT *,
    FIRST_VALUE(event_type) OVER (
      PARTITION BY message_id ORDER BY attempt_window DESC, reset_row DESC, event_row
    ) AS first_type,
    DENSE_RANK() OVER (PARTITION BY message_id ORDER BY attempt_window DESC, reset_row DESC) AS window_rank
  FROM event_windows
  WHERE ignored_by_legacy = 0 AND current_status IN ('submitted', 'sent', 'delayed')
),
effective_outcomes AS (
  SELECT message_id, user_id, provider_message_id, accepted_row, event_row, ROW_NUMBER() OVER (
    PARTITION BY message_id ORDER BY julianday(event_created_at) DESC, event_row DESC
  ) AS preference
  FROM terminal_order
  WHERE event_type = first_type AND window_rank = 1
    AND CASE WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.type') = event_type
        AND json_extract(payload_json, '$.data.email_id') = provider_message_id
        AND julianday(json_extract(payload_json, '$.created_at')) = julianday(event_created_at)
      ELSE 0 END
),
-- 0040 used a single-type fallback for events before the final retry. Undo that fallback
-- when this old timeline proves the recorded terminal event was ignored after a local failure.
ineffective_outcomes AS (
  SELECT DISTINCT event.message_id, event.user_id, event.provider_message_id, event.accepted_row,
    COALESCE((
      SELECT progress.rowid FROM workspace_outbound_events progress
      WHERE progress.message_id = event.message_id AND progress.user_id = event.user_id
        AND progress.provider = 'resend' AND progress.provider_message_id = event.provider_message_id
        AND progress.rowid > event.accepted_row AND progress.event_type IN ('email.sent', 'email.delivery_delayed')
      ORDER BY julianday(progress.event_created_at) DESC, progress.rowid DESC LIMIT 1
    ), event.accepted_row) AS event_row
  FROM event_windows event
  WHERE event.ignored_by_legacy = 1 AND event.current_status = substr(event.event_type, 7)
    AND event.current_event = event.event_type AND event.current_event_at = event.event_created_at
    AND julianday(event.accepted_at) < (
      SELECT julianday(updated_at) FROM workspace_schema_metadata WHERE schema_name = 'flaremail' AND schema_version = 40
    )
    AND NOT EXISTS (
      SELECT 1 FROM event_windows valid
      WHERE valid.message_id = event.message_id AND valid.ignored_by_legacy = 0
    )
    AND NOT EXISTS (
      SELECT 1 FROM workspace_outbound_events other
      WHERE other.message_id = event.message_id AND other.user_id = event.user_id
        AND other.provider = 'resend' AND other.provider_message_id = event.provider_message_id
        AND other.rowid < event.accepted_row
        AND other.event_type IN ('email.failed', 'email.delivered', 'email.bounced', 'email.complained', 'email.suppressed')
        AND (other.event_type <> event.event_type OR julianday(other.created_at) > julianday(event.latest_started_at))
    )
),
selected_outcomes AS (
  SELECT message_id, user_id, provider_message_id, accepted_row, event_row FROM effective_outcomes WHERE preference = 1
  UNION ALL
  SELECT message_id, user_id, provider_message_id, accepted_row, event_row FROM ineffective_outcomes
)
-- Earlier migrations may have queued competing terminal events from the same acceptance window.
UPDATE workspace_outbound_events AS event
SET payload_json = CASE WHEN event.rowid = outcome.event_row
  THEN json_set(json_remove(event.payload_json, '$._flaremailDeferred'), '$._flaremailTerminalRecovery41', 1)
  ELSE json_remove(event.payload_json, '$._flaremailDeferred') END
FROM selected_outcomes outcome
WHERE event.message_id = outcome.message_id AND event.user_id = outcome.user_id
  AND event.provider = 'resend' AND event.provider_message_id = outcome.provider_message_id
  AND (event.rowid = outcome.event_row OR (
    event.rowid < outcome.accepted_row AND event.event_type IN ('email.failed', 'email.delivered', 'email.bounced', 'email.complained', 'email.suppressed')
    AND CASE WHEN json_valid(event.payload_json) THEN json_extract(event.payload_json, '$._flaremailDeferred') = 1 ELSE 0 END
  ));

-- Restore the receipt before the new Worker can reconcile more webhooks.
UPDATE workspace_delivery_statuses AS delivery
SET status = CASE event.event_type
    WHEN 'submission' THEN 'submitted' WHEN 'email.delivery_delayed' THEN 'delayed' ELSE substr(event.event_type, 7) END,
  last_error = CASE event.event_type
    WHEN 'email.delivery_delayed' THEN 'Delivery was delayed by the provider.'
    WHEN 'email.bounced' THEN 'The provider reported a bounce.'
    WHEN 'email.failed' THEN 'The provider reported a delivery failure.'
    WHEN 'email.complained' THEN 'The provider reported a recipient complaint.'
    WHEN 'email.suppressed' THEN 'The provider suppressed the message.'
    ELSE '' END,
  sent_at = CASE WHEN event.event_type = 'email.sent' THEN COALESCE(delivery.sent_at, event.event_created_at) ELSE delivery.sent_at END,
  delivered_at = CASE WHEN event.event_type = 'email.delivered' THEN COALESCE(delivery.delivered_at, event.event_created_at)
    WHEN delivery.status = 'delivered' AND delivery.delivered_at = delivery.last_event_at THEN NULL
    ELSE delivery.delivered_at END,
  last_event = event.event_type, last_event_at = event.event_created_at, updated_at = event.event_created_at
FROM workspace_outbound_events event
WHERE delivery.message_id = event.message_id AND delivery.user_id = event.user_id
  AND delivery.provider_message_id = event.provider_message_id
  AND CASE WHEN json_valid(event.payload_json) THEN json_extract(event.payload_json, '$._flaremailTerminalRecovery41') = 1 ELSE 0 END;

INSERT INTO workspace_outbound_receipts
  (message_id, user_id, provider, result_kind, response_preview, last_event, last_event_at, created_at, updated_at)
SELECT event.message_id, event.user_id, 'resend',
  CASE WHEN event.event_type IN ('submission', 'email.sent', 'email.delivered') THEN 'accepted'
    WHEN event.event_type = 'email.delivery_delayed' THEN 'temporary_failure' ELSE 'permanent_failure' END,
  event.summary, event.event_type, event.event_created_at, event.event_created_at, event.event_created_at
FROM workspace_outbound_events event
JOIN workspace_delivery_statuses delivery ON delivery.message_id = event.message_id AND delivery.user_id = event.user_id
  AND delivery.provider_message_id = event.provider_message_id AND delivery.last_event = event.event_type
  AND delivery.last_event_at = event.event_created_at
WHERE CASE WHEN json_valid(event.payload_json) THEN json_extract(event.payload_json, '$._flaremailTerminalRecovery41') = 1 ELSE 0 END
ON CONFLICT(message_id) DO UPDATE SET provider = excluded.provider, result_kind = excluded.result_kind,
  response_preview = excluded.response_preview, last_event = excluded.last_event, last_event_at = excluded.last_event_at,
  updated_at = excluded.updated_at
WHERE workspace_outbound_receipts.user_id = excluded.user_id;

UPDATE workspace_outbound_events SET payload_json = json_remove(payload_json, '$._flaremailTerminalRecovery41')
WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$._flaremailTerminalRecovery41') = 1 ELSE 0 END;

UPDATE workspace_schema_metadata SET schema_version = 41,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE schema_name = 'flaremail';
