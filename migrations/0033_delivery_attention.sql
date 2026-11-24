CREATE TABLE workspace_delivery_attention_clock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL
);
INSERT INTO workspace_delivery_attention_clock VALUES (1, 0);

CREATE TABLE workspace_delivery_attention (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES workspace_messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('delayed', 'failed', 'bounced', 'complained', 'suppressed', 'stale_submitting')),
  attempt_number INTEGER NOT NULL,
  eligible_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'acknowledged', 'resolved', 'superseded')),
  version INTEGER NOT NULL DEFAULT 0,
  acknowledged_at TEXT,
  closed_at TEXT
);
CREATE INDEX workspace_delivery_attention_owner_order
  ON workspace_delivery_attention(user_id, eligible_at DESC, id DESC);
CREATE INDEX workspace_delivery_attention_owner_kind
  ON workspace_delivery_attention(user_id, kind, eligible_at DESC, id DESC);
CREATE INDEX workspace_delivery_attention_pending
  ON workspace_delivery_attention(user_id, eligible_at DESC, id DESC) WHERE state = 'open';
CREATE INDEX workspace_delivery_attention_message
  ON workspace_delivery_attention(message_id, kind, attempt_number) WHERE closed_at IS NULL;
CREATE INDEX workspace_delivery_attention_message_history
  ON workspace_delivery_attention(message_id);

CREATE TRIGGER workspace_delivery_attention_insert_version AFTER INSERT ON workspace_delivery_attention BEGIN
  UPDATE workspace_delivery_attention_clock SET version = version + 1 WHERE singleton = 1;
  UPDATE workspace_delivery_attention SET version = (SELECT version FROM workspace_delivery_attention_clock)
    WHERE id = new.id;
END;

CREATE TRIGGER workspace_delivery_attention_action_version AFTER UPDATE OF state, eligible_at ON workspace_delivery_attention
WHEN (new.state = 'open' AND old.state = 'acknowledged') OR new.eligible_at <> old.eligible_at BEGIN
  UPDATE workspace_delivery_attention_clock SET version = version + 1 WHERE singleton = 1;
  UPDATE workspace_delivery_attention SET version = (SELECT version FROM workspace_delivery_attention_clock)
    WHERE id = new.id;
END;

-- Restoring a message must not add it to a bulk confirmation snapshot taken while it was in Trash.
CREATE TRIGGER workspace_delivery_attention_visibility_version AFTER UPDATE OF deleted_at ON workspace_messages
WHEN (old.deleted_at IS NULL) <> (new.deleted_at IS NULL)
  AND EXISTS (SELECT 1 FROM workspace_delivery_attention WHERE message_id = new.id AND closed_at IS NULL) BEGIN
  UPDATE workspace_delivery_attention_clock SET version = version + 1 WHERE singleton = 1;
  UPDATE workspace_delivery_attention SET version = (SELECT version FROM workspace_delivery_attention_clock)
    WHERE message_id = new.id AND user_id = new.user_id AND closed_at IS NULL;
END;

CREATE VIEW workspace_delivery_attention_source AS
SELECT ds.user_id, ds.message_id, ds.attempts AS attempt_number,
  CASE WHEN ds.status = 'submitting' THEN 'stale_submitting' ELSE ds.status END AS kind,
  CASE WHEN ds.status = 'submitting'
    THEN strftime('%Y-%m-%dT%H:%M:%S.000Z', COALESCE(ds.last_event_at, ds.updated_at, ds.created_at), '+15 minutes')
    ELSE MIN(
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(ds.last_event_at, ds.updated_at, ds.created_at)),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  END AS eligible_at
FROM workspace_delivery_statuses ds
JOIN workspace_messages m ON m.id = ds.message_id AND m.user_id = ds.user_id AND m.folder = 'sent'
WHERE ds.status IN ('submitting', 'delayed', 'failed', 'bounced', 'complained', 'suppressed');

-- A pending submission has an eligibility time, so the clock alone can make it visible.
-- Status writes, incident transitions, and their versions all commit together.
CREATE TRIGGER workspace_delivery_attention_status_insert AFTER INSERT ON workspace_delivery_statuses
WHEN new.status IN ('submitting', 'delayed', 'failed', 'bounced', 'complained', 'suppressed') BEGIN
  INSERT INTO workspace_delivery_attention (user_id, message_id, attempt_number, kind, eligible_at)
  SELECT user_id, message_id, attempt_number, kind, eligible_at FROM workspace_delivery_attention_source
  WHERE message_id = new.message_id AND eligible_at IS NOT NULL;
END;

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

  -- A retry that has itself stalled replaces the previous actionable failure.
  UPDATE workspace_delivery_attention
  SET state = 'superseded', closed_at = (
    SELECT stale.eligible_at FROM workspace_delivery_attention stale
    WHERE stale.message_id = new.message_id AND stale.user_id = new.user_id
      AND stale.kind = 'stale_submitting' AND stale.closed_at IS NULL
      AND stale.eligible_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  WHERE message_id = new.message_id AND user_id = new.user_id AND closed_at IS NULL
    AND kind <> 'stale_submitting' AND EXISTS (
      SELECT 1 FROM workspace_delivery_attention stale
      WHERE stale.message_id = new.message_id AND stale.user_id = new.user_id
        AND stale.kind = 'stale_submitting' AND stale.closed_at IS NULL
        AND stale.eligible_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    );

  UPDATE workspace_delivery_attention
  SET state = CASE WHEN new.status IN ('submitted', 'sent', 'delivered')
    THEN 'resolved' ELSE 'superseded' END,
    closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE message_id = new.message_id AND user_id = new.user_id AND closed_at IS NULL AND (
    (new.status IN ('delayed', 'failed', 'bounced', 'complained', 'suppressed')
      AND (kind <> new.status OR attempt_number <> new.attempts))
    OR (new.status = 'submitting' AND kind = 'stale_submitting' AND attempt_number <> new.attempts)
    OR (new.status IN ('submitted', 'sent', 'delivered')
      AND NOT (kind = 'delayed' AND attempt_number = new.attempts AND new.status = 'sent'))
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

INSERT INTO workspace_delivery_attention (user_id, message_id, attempt_number, kind, eligible_at)
SELECT user_id, message_id, attempt_number, kind, eligible_at
FROM workspace_delivery_attention_source WHERE eligible_at IS NOT NULL;

UPDATE workspace_schema_metadata SET schema_version = 33,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE schema_name = 'flaremail';
