export interface CloudflareEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
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
