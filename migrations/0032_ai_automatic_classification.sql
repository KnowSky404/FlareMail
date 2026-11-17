-- Keep legacy constrained values for audit; new manual and AI decisions are independent.
ALTER TABLE email_messages ADD COLUMN inbox_category_v2 TEXT CHECK (inbox_category_v2 IS NULL OR inbox_category_v2 IN ('primary', 'transactions', 'security', 'updates', 'subscriptions', 'promotions'));
ALTER TABLE email_messages ADD COLUMN ai_inbox_category TEXT CHECK (ai_inbox_category IS NULL OR ai_inbox_category IN ('primary', 'transactions', 'security', 'updates', 'subscriptions', 'promotions'));
ALTER TABLE workspace_messages ADD COLUMN inbox_category_v2 TEXT CHECK (inbox_category_v2 IS NULL OR inbox_category_v2 IN ('primary', 'transactions', 'security', 'updates', 'subscriptions', 'promotions'));
ALTER TABLE workspace_messages ADD COLUMN ai_inbox_category TEXT CHECK (ai_inbox_category IS NULL OR ai_inbox_category IN ('primary', 'transactions', 'security', 'updates', 'subscriptions', 'promotions'));
UPDATE email_messages SET inbox_category_v2 = CASE WHEN inbox_category IN ('social', 'forums') THEN 'updates' ELSE inbox_category END;
UPDATE workspace_messages SET inbox_category_v2 = CASE WHEN inbox_category IN ('social', 'forums') THEN 'updates' ELSE inbox_category END;

ALTER TABLE mail_ai_analyses ADD COLUMN result_updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE mail_ai_analyses SET result_updated_at = updated_at WHERE status = 'ready';

CREATE TABLE mail_ai_jobs (
  owner_user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  consent_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed', 'cancelled')),
  attempted INTEGER NOT NULL DEFAULT 0 CHECK (attempted IN (0, 1)),
  claim_token TEXT NOT NULL DEFAULT '',
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, message_id)
);
CREATE INDEX mail_ai_jobs_pending ON mail_ai_jobs(status, next_attempt_at);
CREATE TRIGGER mail_ai_jobs_inbound_delete AFTER DELETE ON email_messages BEGIN
  DELETE FROM mail_ai_jobs WHERE owner_user_id = old.owner_user_id AND message_id = old.id;
END;
CREATE TRIGGER mail_ai_jobs_owner_delete AFTER DELETE ON workspace_users BEGIN
  DELETE FROM mail_ai_jobs WHERE owner_user_id = old.id;
END;

UPDATE workspace_schema_metadata SET schema_version = 32,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE schema_name = 'flaremail';
