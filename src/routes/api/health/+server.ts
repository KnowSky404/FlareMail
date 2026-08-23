import { json } from '@sveltejs/kit';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { validateEnvironment } from '$lib/server/config/env';
import { FLAREMAIL_SCHEMA_VERSION } from '$lib/server/db/schema-version';
import { getRequestId } from '$lib/server/http/api';
import type { RequestHandler } from './$types';

const REQUIRED_TABLES = [
  'email_messages',
  'workspace_users',
  'workspace_sessions',
  'workspace_messages',
  'workspace_drafts',
  'workspace_email_states',
  'workspace_settings',
  'workspace_outbound_statuses',
  'workspace_attachments',
  'workspace_delivery_statuses',
  'workspace_login_rate_limits',
  'workspace_outbound_rate_limits',
  'workspace_outbound_receipts',
  'workspace_outbound_events',
  'workspace_inbound_ingest_claims',
  'workspace_delivery_attempts',
  'mail_body_objects',
  'workspace_r2_cleanup_queue',
  'workspace_schema_metadata'
] as const;
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const { platform } = event;
  const env = platform?.env as CloudflareEnv | undefined;
  const validation = validateEnvironment((env ?? {}) as unknown as Record<string, unknown>);
  if (!validation.ok) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'health_check_failed',
      requestId,
      code: 'CONFIG_INVALID',
      diagnostics: validation.errors.map(({ code }) => code)
    }));
  }
  let schemaReady = false;
  let schemaCode: 'D1_UNAVAILABLE' | 'SCHEMA_NOT_READY' = 'D1_UNAVAILABLE';
  let cleanupQueue: { pending: number; processing: number; retryable: number; manualReview: number; staleProcessing: number } | undefined;

  if (env?.DB) {
    try {
      const placeholders = REQUIRED_TABLES.map(() => '?').join(', ');
      const tables = await env.DB.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (${placeholders})
      `).bind(...REQUIRED_TABLES).all<{ name: string }>();
      const version = await env.DB.prepare('SELECT schema_version FROM workspace_schema_metadata WHERE schema_name = ?').bind('flaremail').first<{ schema_version: number }>();
      schemaReady = (tables.results?.length ?? 0) === REQUIRED_TABLES.length && version?.schema_version === FLAREMAIL_SCHEMA_VERSION;
      schemaCode = 'SCHEMA_NOT_READY';
      if (schemaReady) {
        const queue = await env.DB.prepare(`
          SELECT
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
            SUM(CASE WHEN status = 'retryable' THEN 1 ELSE 0 END) AS retryable,
            SUM(CASE WHEN status = 'manual_review' THEN 1 ELSE 0 END) AS manual_review,
            SUM(CASE WHEN status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? THEN 1 ELSE 0 END) AS stale_processing
          FROM workspace_r2_cleanup_queue
        `).bind(new Date().toISOString()).first<{ pending: number | null; processing: number | null; retryable: number | null; manual_review: number | null; stale_processing: number | null }>();
        cleanupQueue = {
          pending: Number(queue?.pending ?? 0),
          processing: Number(queue?.processing ?? 0),
          retryable: Number(queue?.retryable ?? 0),
          manualReview: Number(queue?.manual_review ?? 0),
          staleProcessing: Number(queue?.stale_processing ?? 0)
        };
      }
    } catch {
      schemaReady = false;
      schemaCode = 'D1_UNAVAILABLE';
      console.error(JSON.stringify({
        level: 'error',
        event: 'health_check_failed',
        requestId,
        code: schemaCode
      }));
    }
  }

  const ok = validation.ok && schemaReady;
  const errorCode = !validation.ok ? 'CONFIG_INVALID' : schemaCode;
  return json({
    ok,
    version: env?.APP_VERSION ?? 'development',
    timestamp: new Date().toISOString(),
    requestId,
    ...(cleanupQueue && schemaReady ? { cleanupQueue } : {}),
    ...(ok ? {} : {
      error: {
        code: errorCode,
        message: errorCode === 'CONFIG_INVALID' ? '服务配置尚未完成。' : errorCode === 'D1_UNAVAILABLE' ? '工作区数据服务暂时不可用。' : '服务数据结构尚未就绪。',
        retryable: errorCode !== 'CONFIG_INVALID'
      }
    })
  }, { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store', 'x-request-id': requestId } });
};
