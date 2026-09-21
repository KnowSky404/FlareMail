import { json } from '@sveltejs/kit';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { validateEnvironment } from '$lib/server/config/env';
import { mailHealthState } from '$lib/domain/mail/health';
import { listManagedMailDomains } from '$lib/server/db/mail-identities';
import { FLAREMAIL_SCHEMA_VERSION } from '$lib/server/db/schema-version';
import { getRequestId, withApiHandler } from '$lib/server/http/api';
import { requireWorkspaceSession } from '$lib/server/workspace-api';
import type { RequestHandler } from './$types';

const REQUIRED_TABLES = [
  'email_messages',
  'workspace_users',
  'workspace_owner',
  'workspace_auth_credentials',
  'workspace_sessions',
  'mail_domains',
  'mail_addresses',
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
  'workspace_schema_metadata',
  'workspace_telegram_bindings',
  'workspace_telegram_bind_challenges',
  'workspace_telegram_updates',
  'workspace_telegram_deliveries',
  'workspace_telegram_rate_limits',
  'workspace_telegram_delivery_limits'
] as const;
export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = requireWorkspaceSession(event);
  const requestId = getRequestId(event);
  const { platform } = event;
  const env = platform?.env as CloudflareEnv | undefined;
  const validation = validateEnvironment((env ?? {}) as unknown as Record<string, unknown>);
  if (!validation.ok) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'readiness_check_failed',
      requestId,
      code: 'CONFIG_INVALID',
      diagnostics: validation.errors.map(({ code }) => code)
    }));
  }
  let schemaReady = false;
  let schemaCode: 'D1_UNAVAILABLE' | 'SCHEMA_NOT_READY' = 'D1_UNAVAILABLE';
  let cleanupQueue: { pending: number; processing: number; retryable: number; manualReview: number; staleProcessing: number } | undefined;
  let mailHealth: Array<Record<string, unknown>> | undefined;
  const now = new Date();
  const nowMs = now.getTime();

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
        const domains = await listManagedMailDomains(env.DB, session.userId);
        mailHealth = domains.map((domain) => ({
          domainId: domain.id,
          domainName: domain.domain_name,
          enabled: Boolean(domain.enabled),
          unknownRecipientPolicy: domain.unknown_recipient_policy,
          catchAllTarget: domain.catch_all_target,
          cloudflare: {
            state: mailHealthState({
              configured: Boolean(env?.CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN?.trim() || env?.CLOUDFLARE_EMAIL_ROUTING_TOKEN?.trim()),
              checkedAt: domain.cloudflare_checked_at,
              leaseExpiresAt: domain.cloudflare_check_expires_at,
              errorCode: domain.cloudflare_error_code,
              nowMs
            }),
            checkedAt: domain.cloudflare_checked_at,
            catchAllCheckedAt: domain.catch_all_checked_at,
            nextCheckAt: domain.cloudflare_next_check_at,
            lastFailureAt: domain.cloudflare_error_at,
            errorCode: domain.cloudflare_error_code
          },
          resend: {
            state: mailHealthState({
              configured: Boolean(env?.RESEND_API_KEY?.trim()),
              checkedAt: domain.resend_checked_at,
              leaseExpiresAt: domain.resend_check_expires_at,
              errorCode: domain.resend_error_code,
              nowMs
            }),
            checkedAt: domain.resend_checked_at,
            nextCheckAt: domain.resend_next_check_at,
            lastFailureAt: domain.resend_error_at,
            errorCode: domain.resend_error_code,
            status: domain.resend_status,
            sendingStatus: domain.resend_sending_status
          }
        }));
      }
    } catch {
      schemaReady = false;
      schemaCode = 'D1_UNAVAILABLE';
      console.error(JSON.stringify({
        level: 'error',
        event: 'readiness_check_failed',
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
    timestamp: now.toISOString(),
    requestId,
    ...(cleanupQueue && schemaReady ? { cleanupQueue } : {}),
    ...(mailHealth && schemaReady ? { mailHealth } : {}),
    ...(ok ? {} : {
      error: {
        code: errorCode,
        message: errorCode === 'CONFIG_INVALID' ? '服务配置尚未完成。' : errorCode === 'D1_UNAVAILABLE' ? '工作区数据服务暂时不可用。' : '服务数据结构尚未就绪。',
        retryable: errorCode !== 'CONFIG_INVALID'
      }
    })
  }, { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store', 'x-request-id': requestId } });
});
