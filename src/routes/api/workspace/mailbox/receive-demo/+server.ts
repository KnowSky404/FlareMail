import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireWorkspaceSession } from '$lib/server/workspace-api';
import { receiveDemoMessage } from '$lib/server/workspace';

export const POST: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);
  const result = receiveDemoMessage(session);

  return json({
    ok: true,
    ...result
  });
};
