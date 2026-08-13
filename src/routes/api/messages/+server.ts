import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';

/** Compatibility listing endpoint. It is authenticated and returns no R2 keys. */
export const GET: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  if (!env?.DB) return json({ ok: false, error: '入站存储服务暂不可用。' }, { status: 503 });
  const requestedLimit = Number(event.url.searchParams.get('limit') ?? '20');
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100) : 20;

  const result = await env.DB.prepare(`
    SELECT id, message_id, "from", "to", subject, "timestamp", snippet, raw_size, created_at
    FROM email_messages
    WHERE owner_user_id = ?
    ORDER BY "timestamp" DESC, id DESC
    LIMIT ?
  `).bind(session.userId, limit).all();
  return json({ ok: true, limit, messages: result.results ?? [] }, {
    headers: { 'cache-control': 'private, no-store' }
  });
};
