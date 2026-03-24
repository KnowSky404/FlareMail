import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';
import { receiveDemoMessage } from '$lib/server/workspace';

export const POST: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  const result = await receiveDemoMessage(env, session);

  return json({
    ok: true,
    ...result
  });
};
