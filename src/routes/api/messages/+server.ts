import { json } from '@sveltejs/kit';
import type { CloudflareEnv, StoredEmailMessage } from '$lib/server/cloudflare';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform, url }) => {
  const env = platform?.env as CloudflareEnv | undefined;

  if (!env?.DB) {
    return json(
      {
        ok: false,
        error: 'DB binding is not available in this runtime.'
      },
      { status: 503 }
    );
  }

  const requestedLimit = Number(url.searchParams.get('limit') ?? '20');
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 20;

  try {
    const result = await env.DB.prepare(
      `
        SELECT
          id,
          message_id,
          "from",
          "to",
          subject,
          "timestamp",
          snippet,
          raw_key,
          raw_size,
          created_at
        FROM email_messages
        ORDER BY "timestamp" DESC
        LIMIT ?
      `
    )
      .bind(limit)
      .all<StoredEmailMessage>();

    return json({
      ok: true,
      limit,
      messages: result.results ?? []
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to read email metadata.'
      },
      { status: 500 }
    );
  }
};
