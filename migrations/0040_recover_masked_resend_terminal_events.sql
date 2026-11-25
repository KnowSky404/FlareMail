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
  THEN json_set(json_remove(event.payload_json, '$._flaremailDeferred'), '$._flaremailTerminalRecovery40', 1)
  ELSE json_remove(event.payload_json, '$._flaremailDeferred') END
FROM effective_outcomes outcome
WHERE outcome.preference = 1 AND event.message_id = outcome.message_id AND event.user_id = outcome.user_id
  AND event.provider = 'resend' AND event.provider_message_id = outcome.provider_message_id
  AND event.rowid < outcome.accepted_row
  AND (event.rowid = outcome.event_row OR (
    event.event_type IN ('email.failed', 'email.delivered', 'email.bounced', 'email.complained', 'email.suppressed')
    AND CASE WHEN json_valid(event.payload_json) THEN json_extract(event.payload_json, '$._flaremailDeferred') = 1 ELSE 0 END
  ));

-- Restore the receipt before the new Worker can reconcile more webhooks.
UPDATE workspace_delivery_statuses AS delivery
SET status = substr(event.event_type, 7),
  last_error = CASE event.event_type
    WHEN 'email.bounced' THEN 'The provider reported a bounce.'
    WHEN 'email.failed' THEN 'The provider reported a delivery failure.'
    WHEN 'email.complained' THEN 'The provider reported a recipient complaint.'
    WHEN 'email.suppressed' THEN 'The provider suppressed the message.'
    ELSE '' END,
  delivered_at = CASE WHEN event.event_type = 'email.delivered' THEN COALESCE(delivery.delivered_at, event.event_created_at)
    ELSE delivery.delivered_at END,
  last_event = event.event_type, last_event_at = event.event_created_at, updated_at = event.event_created_at
FROM workspace_outbound_events event
WHERE delivery.message_id = event.message_id AND delivery.user_id = event.user_id
  AND delivery.provider_message_id = event.provider_message_id
  AND CASE WHEN json_valid(event.payload_json) THEN json_extract(event.payload_json, '$._flaremailTerminalRecovery40') = 1 ELSE 0 END;

INSERT INTO workspace_outbound_receipts
  (message_id, user_id, provider, result_kind, response_preview, last_event, last_event_at, created_at, updated_at)
SELECT event.message_id, event.user_id, 'resend',
  CASE WHEN event.event_type = 'email.delivered' THEN 'accepted' ELSE 'permanent_failure' END,
  event.summary, event.event_type, event.event_created_at, event.event_created_at, event.event_created_at
FROM workspace_outbound_events event
JOIN workspace_delivery_statuses delivery ON delivery.message_id = event.message_id AND delivery.user_id = event.user_id
  AND delivery.provider_message_id = event.provider_message_id AND delivery.last_event = event.event_type
  AND delivery.last_event_at = event.event_created_at
WHERE CASE WHEN json_valid(event.payload_json) THEN json_extract(event.payload_json, '$._flaremailTerminalRecovery40') = 1 ELSE 0 END
ON CONFLICT(message_id) DO UPDATE SET provider = excluded.provider, result_kind = excluded.result_kind,
  response_preview = excluded.response_preview, last_event = excluded.last_event, last_event_at = excluded.last_event_at,
  updated_at = excluded.updated_at
WHERE workspace_outbound_receipts.user_id = excluded.user_id;

UPDATE workspace_outbound_events SET payload_json = json_remove(payload_json, '$._flaremailTerminalRecovery40')
WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$._flaremailTerminalRecovery40') = 1 ELSE 0 END;

-- Keep the full precision of a submission start when deriving its timeout.
DROP VIEW IF EXISTS workspace_delivery_attention_source;
CREATE VIEW workspace_delivery_attention_source AS
SELECT ds.user_id, ds.message_id, ds.attempts AS attempt_number,
  CASE WHEN ds.status = 'submitting' THEN 'stale_submitting' ELSE ds.status END AS kind,
  CASE WHEN ds.status = 'submitting'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(ds.last_event_at, ds.updated_at, ds.created_at), '+15 minutes')
    ELSE MIN(
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(ds.last_event_at, ds.updated_at, ds.created_at)),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  END AS eligible_at
FROM workspace_delivery_statuses ds
JOIN workspace_messages m ON m.id = ds.message_id AND m.user_id = ds.user_id AND m.folder = 'sent'
WHERE ds.status IN ('submitting', 'delayed', 'failed', 'bounced', 'complained', 'suppressed');

-- A later still-submitting event must not postpone an alert that was already due.
UPDATE workspace_delivery_attention AS attention
SET eligible_at = source.eligible_at
FROM workspace_delivery_attention_source source
WHERE source.user_id = attention.user_id AND source.message_id = attention.message_id
  AND source.attempt_number = attention.attempt_number AND source.kind = 'stale_submitting'
  AND attention.kind = 'stale_submitting' AND attention.closed_at IS NULL
  AND attention.eligible_at = strftime('%Y-%m-%dT%H:%M:%S.000Z', source.eligible_at)
  AND attention.eligible_at <> source.eligible_at;

UPDATE workspace_schema_metadata SET schema_version = 40,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE schema_name = 'flaremail';
