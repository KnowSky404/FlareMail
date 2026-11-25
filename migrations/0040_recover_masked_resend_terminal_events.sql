-- Legacy same-ID acceptance could overwrite a definitive outcome already recorded by Resend.
WITH eligible_retries AS (
  SELECT delivery.message_id, delivery.user_id, delivery.provider_message_id,
    latest.started_at, acceptance.rowid AS accepted_row, prior_acceptance.rowid AS prior_accepted_row
  FROM workspace_delivery_statuses delivery
  JOIN workspace_delivery_attempts latest ON latest.message_id = delivery.message_id AND latest.user_id = delivery.user_id
    AND latest.attempt_number = delivery.attempts AND latest.provider_message_id = delivery.provider_message_id
  JOIN workspace_outbound_events acceptance ON acceptance.svix_id = 'local:' || delivery.message_id || ':submission:' || delivery.attempts
    AND acceptance.message_id = delivery.message_id AND acceptance.user_id = delivery.user_id
    AND acceptance.provider_message_id = delivery.provider_message_id AND acceptance.event_type = 'submission'
  LEFT JOIN workspace_outbound_events prior_acceptance
    ON prior_acceptance.svix_id = 'local:' || delivery.message_id || ':submission:' || (delivery.attempts - 1)
    AND prior_acceptance.message_id = delivery.message_id AND prior_acceptance.user_id = delivery.user_id
    AND prior_acceptance.provider_message_id = delivery.provider_message_id AND prior_acceptance.event_type = 'submission'
    AND prior_acceptance.rowid < acceptance.rowid
  WHERE delivery.provider = 'resend' AND delivery.status IN ('submitted', 'sent', 'delayed') AND latest.status = 'submitted'
    AND delivery.provider_message_id = (
      SELECT prior.provider_message_id FROM workspace_delivery_attempts prior
      WHERE prior.message_id = delivery.message_id AND prior.user_id = delivery.user_id
        AND prior.attempt_number < delivery.attempts AND prior.provider_message_id IS NOT NULL
      ORDER BY prior.attempt_number DESC LIMIT 1
    )
),
-- The retry reset the terminal-state guard. Earlier events can use the prior acceptance as their boundary.
terminal_events AS (
  SELECT retry.message_id, event.rowid AS event_row, event.event_type, event.event_created_at,
    retry.user_id, retry.accepted_row, event.provider_message_id, event.payload_json,
    CASE WHEN julianday(event.created_at) > julianday(retry.started_at) THEN 2
      WHEN event.rowid > retry.prior_accepted_row THEN 1 ELSE 0 END AS decision_window
  FROM eligible_retries retry
  JOIN workspace_outbound_events event ON event.message_id = retry.message_id AND event.user_id = retry.user_id
    AND event.provider = 'resend' AND event.provider_message_id = retry.provider_message_id
    AND event.event_type IN ('email.failed', 'email.delivered', 'email.bounced', 'email.complained', 'email.suppressed')
  WHERE event.rowid < retry.accepted_row
    AND NOT EXISTS (
      SELECT 1 FROM workspace_outbound_events later
      WHERE later.message_id = retry.message_id AND later.user_id = retry.user_id
        AND later.provider = 'resend' AND later.provider_message_id = retry.provider_message_id
        AND later.rowid > retry.accepted_row
        AND later.event_type IN ('email.failed', 'email.delivered', 'email.bounced', 'email.complained', 'email.suppressed')
    )
),
terminal_order AS (
  SELECT *,
    FIRST_VALUE(event_type) OVER (PARTITION BY message_id ORDER BY decision_window DESC, event_row) AS first_type,
    MAX(decision_window) OVER (PARTITION BY message_id) AS latest_window,
    MIN(event_type) OVER (PARTITION BY message_id) = MAX(event_type) OVER (PARTITION BY message_id) AS one_type
  FROM terminal_events
),
effective_outcomes AS (
  SELECT message_id, user_id, provider_message_id, accepted_row, event_row, ROW_NUMBER() OVER (
    PARTITION BY message_id ORDER BY julianday(event_created_at) DESC, event_row DESC
  ) AS preference
  FROM terminal_order
  WHERE event_type = first_type AND decision_window = latest_window AND (latest_window > 0 OR one_type)
    AND CASE WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.type') = event_type
        AND json_extract(payload_json, '$.data.email_id') = provider_message_id
        AND julianday(json_extract(payload_json, '$.created_at')) = julianday(event_created_at)
      ELSE 0 END
)
-- Earlier migrations may have queued competing terminal events from the same acceptance window.
UPDATE workspace_outbound_events AS event
SET payload_json = CASE WHEN event.rowid = outcome.event_row
  THEN json_set(event.payload_json, '$._flaremailDeferred', 1)
  ELSE json_remove(event.payload_json, '$._flaremailDeferred') END
FROM effective_outcomes outcome
WHERE outcome.preference = 1 AND event.message_id = outcome.message_id AND event.user_id = outcome.user_id
  AND event.provider = 'resend' AND event.provider_message_id = outcome.provider_message_id
  AND event.rowid < outcome.accepted_row
  AND (event.rowid = outcome.event_row OR (
    event.event_type IN ('email.failed', 'email.delivered', 'email.bounced', 'email.complained', 'email.suppressed')
    AND CASE WHEN json_valid(event.payload_json) THEN json_extract(event.payload_json, '$._flaremailDeferred') = 1 ELSE 0 END
  ));

UPDATE workspace_schema_metadata SET schema_version = 40,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE schema_name = 'flaremail';
