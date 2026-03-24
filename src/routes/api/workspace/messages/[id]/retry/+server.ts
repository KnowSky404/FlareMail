import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';
import { retryWorkspaceMessageDelivery } from '$lib/server/workspace';

export const POST: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  const result = await retryWorkspaceMessageDelivery(env, session, event.params.id);

  if (!result) {
    return json(
      {
        ok: false,
        error: '当前邮件不支持重试投递。'
      },
      { status: 404 }
    );
  }

  return json({
    ok: true,
    ...result
  });
};
