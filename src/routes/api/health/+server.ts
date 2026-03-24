import { json } from '@sveltejs/kit';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform }) => {
  const env = platform?.env as CloudflareEnv | undefined;
  const bindings = {
    db: Boolean(env?.DB),
    bucket: Boolean(env?.BUCKET)
  };

  if (!env?.DB) {
    return json(
      {
        ok: false,
        bindings,
        schemaReady: false,
        reason: 'DB binding is not available in this runtime.'
      },
      { status: 503 }
    );
  }

  const table = await env.DB.prepare(
    `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'email_messages'
    `
  ).first<{ name: string }>();

  return json({
    ok: true,
    bindings,
    schemaReady: Boolean(table?.name)
  });
};
