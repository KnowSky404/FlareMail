import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';
import { getWorkspaceMessageDeliveryDetail } from '$lib/server/workspace';

export const GET: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  const detail = await getWorkspaceMessageDeliveryDetail(env, session, event.params.id);

  if (!detail) {
    return json(
      {
        ok: false,
        error: '当前邮件没有可用的投递回执。'
      },
      { status: 404 }
    );
  }

  return json({
    ok: true,
    detail
  });
};
