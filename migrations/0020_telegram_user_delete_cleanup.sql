-- Keep Telegram authorization and unsent notification work from surviving a
-- workspace account deletion. In-flight external requests are intentionally
-- not rewritten because they may already be visible to Telegram.
CREATE TRIGGER workspace_users_telegram_delete_cleanup
AFTER DELETE ON workspace_users
BEGIN
  DELETE FROM workspace_telegram_delivery_limits
  WHERE scope = 'user:' || old.id
     OR scope IN (
       SELECT 'chat:' || telegram_chat_id
       FROM workspace_telegram_bindings
       WHERE user_id = old.id AND telegram_chat_id IS NOT NULL
     );

  UPDATE workspace_telegram_bind_challenges
  SET status = CASE WHEN status = 'pending' THEN 'replaced' ELSE status END,
      replaced_at = CASE WHEN status = 'pending' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE replaced_at END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE owner_user_id = old.id AND status = 'pending';

  UPDATE workspace_telegram_deliveries
  SET status = 'cancelled', claim_token = NULL, lease_expires_at = NULL,
      completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE owner_user_id = old.id
    AND status IN ('pending', 'retryable', 'processing')
    AND external_started = 0;

  UPDATE workspace_telegram_bindings
  SET state = 'revoked', enabled = 0, telegram_user_id = NULL, telegram_chat_id = NULL,
      telegram_username = NULL, telegram_display_name = '', candidate_challenge_id = NULL,
      candidate_expires_at = NULL, authorization_version = authorization_version + 1,
      revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE user_id = old.id;

  DELETE FROM workspace_telegram_rate_limits WHERE user_id = old.id;
END;

INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
VALUES ('flaremail', 20, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(schema_name) DO UPDATE SET schema_version = excluded.schema_version, updated_at = excluded.updated_at;
