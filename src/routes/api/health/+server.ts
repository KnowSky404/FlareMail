import { json } from '@sveltejs/kit';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { validateEnvironment } from '$lib/server/config/env';
import { FLAREMAIL_SCHEMA_VERSION } from '$lib/server/db/schema-version';
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
  'workspace_outbound_receipts',
  'workspace_outbound_events',
  'workspace_inbound_ingest_claims',
  'workspace_delivery_attempts',
  'workspace_schema_metadata'
] as const;
export const GET: RequestHandler = async ({ platform }) => {
  const env = platform?.env as CloudflareEnv | undefined;
  const validation = validateEnvironment((env ?? {}) as unknown as Record<string, unknown>);
  let schemaReady = false;

  if (env?.DB) {
    try {
      const placeholders = REQUIRED_TABLES.map(() => '?').join(', ');
      const tables = await env.DB.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (${placeholders})
      `).bind(...REQUIRED_TABLES).all<{ name: string }>();
      const version = await env.DB.prepare('SELECT schema_version FROM workspace_schema_metadata WHERE schema_name = ?').bind('flaremail').first<{ schema_version: number }>();
      schemaReady = (tables.results?.length ?? 0) === REQUIRED_TABLES.length && version?.schema_version === FLAREMAIL_SCHEMA_VERSION;
    } catch {
      schemaReady = false;
    }
  }

  const ok = validation.ok && schemaReady;
  return json({
    ok,
    version: env?.APP_VERSION ?? 'development',
    timestamp: new Date().toISOString()
  }, { status: ok ? 200 : 503 });
};
