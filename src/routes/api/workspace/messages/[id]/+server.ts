import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';
import { deleteWorkspaceMessage } from '$lib/server/workspace';

export const DELETE: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  const result = await deleteWorkspaceMessage(env, session, event.params.id);

  if (!result) {
    return json(
      {
        ok: false,
        error: '邮件不存在。'
      },
      { status: 404 }
    );
  }

  return json({
    ok: true,
    ...result
  });
};
