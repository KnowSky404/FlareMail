ALTER TABLE mail_domains ADD COLUMN cloudflare_next_check_at TEXT;
ALTER TABLE mail_domains ADD COLUMN cloudflare_check_token TEXT;
ALTER TABLE mail_domains ADD COLUMN cloudflare_check_expires_at TEXT;
ALTER TABLE mail_domains ADD COLUMN cloudflare_error_code TEXT
  CHECK (cloudflare_error_code IS NULL OR length(cloudflare_error_code) <= 64);
ALTER TABLE mail_domains ADD COLUMN cloudflare_error_at TEXT;
ALTER TABLE mail_domains ADD COLUMN cloudflare_failure_count INTEGER NOT NULL DEFAULT 0
  CHECK (cloudflare_failure_count >= 0);

ALTER TABLE mail_domains ADD COLUMN resend_next_check_at TEXT;
ALTER TABLE mail_domains ADD COLUMN resend_check_token TEXT;
ALTER TABLE mail_domains ADD COLUMN resend_check_expires_at TEXT;
ALTER TABLE mail_domains ADD COLUMN resend_error_code TEXT
  CHECK (resend_error_code IS NULL OR length(resend_error_code) <= 64);
ALTER TABLE mail_domains ADD COLUMN resend_error_at TEXT;
ALTER TABLE mail_domains ADD COLUMN resend_failure_count INTEGER NOT NULL DEFAULT 0
  CHECK (resend_failure_count >= 0);

CREATE INDEX idx_mail_domains_cloudflare_health_due
  ON mail_domains(cloudflare_next_check_at, cloudflare_check_expires_at, id);
CREATE INDEX idx_mail_domains_resend_health_due
  ON mail_domains(resend_next_check_at, resend_check_expires_at, id);

INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
VALUES ('flaremail', 25, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(schema_name) DO UPDATE SET schema_version = excluded.schema_version, updated_at = excluded.updated_at;
