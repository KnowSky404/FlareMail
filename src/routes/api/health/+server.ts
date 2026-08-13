import { json } from '@sveltejs/kit';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { validateEnvironment } from '$lib/server/config/env';
import type { RequestHandler } from './$types';

const REQUIRED_TABLES = [
  'email_messages',
  'workspace_users',
  'workspace_sessions',
  'workspace_attachments',
  'workspace_delivery_statuses'
] as const;

export const GET: RequestHandler = async ({ platform }) => {
  const env = platform?.env as CloudflareEnv | undefined;
  const validation = validateEnvironment((env ?? {}) as unknown as Record<string, unknown>);
  let schemaReady = false;
  let schemaVersion: string | null = null;

  if (env?.DB) {
    try {
      const placeholders = REQUIRED_TABLES.map(() => '?').join(', ');
      const tables = await env.DB.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (${placeholders})
      `).bind(...REQUIRED_TABLES).all<{ name: string }>();
      schemaReady = (tables.results?.length ?? 0) === REQUIRED_TABLES.length;
      const latest = await env.DB.prepare(`SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1`)
        .first<{ name: string }>();
      schemaVersion = latest?.name?.replace(/\.sql$/u, '') ?? null;
    } catch {
      schemaReady = false;
    }
  }

  const ok = validation.ok && schemaReady;
  return json({
    ok,
    version: env?.APP_VERSION ?? 'development',
    environment: validation.config.appEnv,
    schema: { ready: schemaReady, version: schemaVersion },
    services: {
      database: validation.config.hasD1,
      objectStorage: validation.config.hasR2,
      outbound: validation.config.hasResendApiKey && validation.config.outboundProvider === 'resend',
      webhookVerification: Boolean(env?.RESEND_WEBHOOK_SECRET)
    },
    timestamp: new Date().toISOString()
  }, { status: ok ? 200 : 503 });
};
