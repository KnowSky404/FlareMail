CREATE TABLE IF NOT EXISTS email_messages (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  "from" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  "timestamp" TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  raw_key TEXT NOT NULL,
  raw_size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_email_messages_timestamp
  ON email_messages("timestamp" DESC);

CREATE INDEX IF NOT EXISTS idx_email_messages_from
  ON email_messages("from");

CREATE INDEX IF NOT EXISTS idx_email_messages_to
  ON email_messages("to");
