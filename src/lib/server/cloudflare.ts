export interface CloudflareEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
  OUTBOUND_PROVIDER?: 'demo' | 'resend';
  OUTBOUND_FROM_EMAIL?: string;
  OUTBOUND_FROM_NAME?: string;
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
