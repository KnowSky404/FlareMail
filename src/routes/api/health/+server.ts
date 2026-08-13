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

  if (env?.DB) {
    try {
      const placeholders = REQUIRED_TABLES.map(() => '?').join(', ');
      const tables = await env.DB.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (${placeholders})
      `).bind(...REQUIRED_TABLES).all<{ name: string }>();
      schemaReady = (tables.results?.length ?? 0) === REQUIRED_TABLES.length;
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
