export interface CloudflareEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
  OUTBOUND_EMAIL?: SendEmail;
  OUTBOUND_PROVIDER?: 'demo' | 'resend' | 'cloudflare';
  OUTBOUND_FROM_EMAIL?: string;
  OUTBOUND_FROM_NAME?: string;
  AUTO_REPLY_ENABLED?: string;
  AUTO_REPLY_SUBJECT_PREFIX?: string;
  AUTO_REPLY_TEXT?: string;
  INBOUND_NOTIFICATION_ENABLED?: string;
  NOTIFICATION_EMAIL?: string;
  NOTIFICATION_SUBJECT_PREFIX?: string;
  RESEND_API_KEY?: string;
  RESEND_API_BASE_URL?: string;
  RESEND_WEBHOOK_SECRET?: string;
}

export interface StoredEmailMessage {
  id: string;
  message_id: string | null;
  from: string;
  to: string;
  subject: string;
  timestamp: string;
  snippet: string;
  raw_key: string;
  raw_size: number;
  created_at: string;
}
