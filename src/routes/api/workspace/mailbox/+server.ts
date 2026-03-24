import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireWorkspaceSession } from '$lib/server/workspace-api';
import { serializeWorkspace } from '$lib/server/workspace';

export const GET: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);

  return json({
    ok: true,
    workspace: serializeWorkspace(session)
  });
};
