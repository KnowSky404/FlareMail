-- The old retry could overwrite a provider failure with a local failure and ignore a stale webhook.
WITH corrections AS (
  SELECT valid.rowid AS event_row, stale.event_created_at AS stale_at, valid.event_created_at AS valid_at,
    ROW_NUMBER() OVER (
      PARTITION BY delivery.message_id ORDER BY julianday(valid.event_created_at) DESC, valid.rowid DESC
    ) AS preference
  FROM workspace_delivery_statuses delivery
  JOIN workspace_outbound_receipts receipt ON receipt.message_id = delivery.message_id AND receipt.user_id = delivery.user_id
    AND receipt.provider = 'resend' AND receipt.result_kind = 'permanent_failure'
    AND receipt.last_event = 'email.failed' AND receipt.last_event_at = delivery.last_event_at
  JOIN workspace_delivery_attempts latest ON latest.message_id = delivery.message_id AND latest.user_id = delivery.user_id
    AND latest.attempt_number = delivery.attempts AND latest.provider_message_id = delivery.provider_message_id
    AND latest.status = 'submitted'
  JOIN workspace_outbound_events acceptance ON acceptance.svix_id = 'local:' || delivery.message_id || ':submission:' || delivery.attempts
    AND acceptance.message_id = delivery.message_id AND acceptance.user_id = delivery.user_id
    AND acceptance.provider = 'resend' AND acceptance.provider_message_id = delivery.provider_message_id
    AND acceptance.event_type = 'submission'
  JOIN workspace_delivery_attempts prior ON prior.message_id = delivery.message_id AND prior.user_id = delivery.user_id
    AND prior.provider = 'resend' AND prior.provider_message_id = delivery.provider_message_id AND prior.status = 'submitted'
    AND prior.attempt_number = (
      SELECT MAX(previous.attempt_number) FROM workspace_delivery_attempts previous
      WHERE previous.message_id = delivery.message_id AND previous.user_id = delivery.user_id
        AND previous.attempt_number < delivery.attempts AND previous.provider_message_id IS NOT NULL
    )
  JOIN workspace_outbound_events prior_acceptance
    ON prior_acceptance.svix_id = 'local:' || delivery.message_id || ':submission:' || prior.attempt_number
    AND prior_acceptance.message_id = delivery.message_id AND prior_acceptance.user_id = delivery.user_id
    AND prior_acceptance.provider = 'resend' AND prior_acceptance.provider_message_id = delivery.provider_message_id
    AND prior_acceptance.event_type = 'submission'
  JOIN workspace_outbound_events stale ON stale.message_id = delivery.message_id AND stale.user_id = delivery.user_id
    AND stale.provider = 'resend' AND stale.provider_message_id = delivery.provider_message_id
    AND stale.event_type = 'email.failed' AND stale.event_created_at = delivery.last_event_at
    AND stale.summary = receipt.response_preview
    AND stale.rowid < acceptance.rowid AND julianday(stale.created_at) < julianday(latest.started_at)
  JOIN workspace_delivery_attempts interrupted ON interrupted.message_id = delivery.message_id AND interrupted.user_id = delivery.user_id
    AND interrupted.provider = 'resend' AND interrupted.provider_message_id IS NULL AND interrupted.status = 'failed'
    AND interrupted.attempt_number > prior.attempt_number AND interrupted.attempt_number = (
      SELECT MAX(started.attempt_number) FROM workspace_delivery_attempts started
      WHERE started.message_id = delivery.message_id AND started.user_id = delivery.user_id AND started.attempt_number < delivery.attempts
        AND julianday(started.started_at) < julianday(stale.created_at)
    )
  JOIN workspace_outbound_events local_failure
    ON local_failure.svix_id = 'local:' || delivery.message_id || ':submission:' || interrupted.attempt_number
    AND local_failure.message_id = delivery.message_id AND local_failure.user_id = delivery.user_id
    AND local_failure.provider = 'resend' AND local_failure.provider_message_id IS NULL AND local_failure.event_type = 'submission'
    AND local_failure.rowid < stale.rowid AND julianday(local_failure.created_at) < julianday(stale.created_at)
    AND CASE WHEN json_valid(local_failure.payload_json) THEN json_extract(local_failure.payload_json, '$.status') = 'failed' ELSE 0 END
  JOIN workspace_outbound_events valid ON valid.message_id = delivery.message_id AND valid.user_id = delivery.user_id
    AND valid.provider = 'resend' AND valid.provider_message_id = delivery.provider_message_id AND valid.event_type = 'email.failed'
    AND valid.rowid > prior_acceptance.rowid AND valid.rowid < local_failure.rowid
    AND julianday(valid.created_at) > julianday(interrupted.started_at)
    AND julianday(valid.created_at) < julianday(local_failure.created_at)
  WHERE delivery.provider = 'resend' AND delivery.status = 'failed' AND delivery.last_event = 'email.failed'
    AND julianday(stale.event_created_at) < julianday(local_failure.event_created_at)
    AND julianday(acceptance.created_at) < (
      SELECT julianday(updated_at) FROM workspace_schema_metadata WHERE schema_name = 'flaremail' AND schema_version = 41
    )
    AND CASE WHEN json_valid(stale.payload_json) AND json_valid(valid.payload_json)
      THEN json_extract(stale.payload_json, '$.type') = stale.event_type
        AND json_extract(stale.payload_json, '$.data.email_id') = stale.provider_message_id
        AND julianday(json_extract(stale.payload_json, '$.created_at')) = julianday(stale.event_created_at)
        AND json_extract(valid.payload_json, '$.type') = valid.event_type
        AND json_extract(valid.payload_json, '$.data.email_id') = valid.provider_message_id
        AND julianday(json_extract(valid.payload_json, '$.created_at')) = julianday(valid.event_created_at)
      ELSE 0 END
    AND NOT EXISTS (
      SELECT 1 FROM workspace_outbound_events competing
      WHERE competing.message_id = delivery.message_id AND competing.user_id = delivery.user_id
        AND competing.provider = 'resend' AND competing.provider_message_id = delivery.provider_message_id
        AND competing.event_type IN ('email.failed', 'email.delivered', 'email.bounced', 'email.complained', 'email.suppressed')
        AND (competing.rowid > acceptance.rowid OR competing.event_type <> 'email.failed'
          OR julianday(competing.created_at) >= julianday(latest.started_at)
          OR julianday(competing.event_created_at) > julianday(stale.event_created_at)
          OR (competing.event_created_at = stale.event_created_at AND competing.rowid > stale.rowid))
    )
)
UPDATE workspace_outbound_events AS event
SET payload_json = json_set(event.payload_json, '$._flaremailFailureReceipt42', correction.stale_at)
FROM corrections correction
WHERE correction.preference = 1 AND event.rowid = correction.event_row
  AND julianday(correction.valid_at) < julianday(correction.stale_at);

UPDATE workspace_delivery_attention AS attention
SET eligible_at = strftime('%Y-%m-%dT%H:%M:%fZ', event.event_created_at)
FROM workspace_outbound_events event
JOIN workspace_delivery_statuses delivery ON delivery.message_id = event.message_id AND delivery.user_id = event.user_id
  AND delivery.provider_message_id = event.provider_message_id
WHERE attention.message_id = event.message_id AND attention.user_id = event.user_id
  AND attention.attempt_number = delivery.attempts AND attention.kind = 'failed' AND attention.closed_at IS NULL
  AND attention.eligible_at = CASE WHEN json_valid(event.payload_json)
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(event.payload_json, '$._flaremailFailureReceipt42')) END;

UPDATE workspace_outbound_receipts AS receipt
SET response_preview = event.summary, last_event_at = event.event_created_at,
  updated_at = CASE WHEN receipt.updated_at = receipt.last_event_at THEN event.event_created_at ELSE receipt.updated_at END
FROM workspace_outbound_events event
WHERE receipt.message_id = event.message_id AND receipt.user_id = event.user_id
  AND receipt.last_event = 'email.failed'
  AND receipt.last_event_at = CASE WHEN json_valid(event.payload_json) THEN json_extract(event.payload_json, '$._flaremailFailureReceipt42') END;

UPDATE workspace_delivery_statuses AS delivery
SET last_event_at = event.event_created_at,
  updated_at = CASE WHEN delivery.updated_at = delivery.last_event_at THEN event.event_created_at ELSE delivery.updated_at END
FROM workspace_outbound_events event
WHERE delivery.message_id = event.message_id AND delivery.user_id = event.user_id
  AND delivery.provider_message_id = event.provider_message_id AND delivery.last_event = 'email.failed'
  AND delivery.last_event_at = CASE WHEN json_valid(event.payload_json) THEN json_extract(event.payload_json, '$._flaremailFailureReceipt42') END;

UPDATE workspace_outbound_events SET payload_json = json_remove(payload_json, '$._flaremailFailureReceipt42')
WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$._flaremailFailureReceipt42') IS NOT NULL ELSE 0 END;

UPDATE workspace_schema_metadata SET schema_version = 42,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE schema_name = 'flaremail';
