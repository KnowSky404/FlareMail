import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { UserProfile } from '$lib/mock/mailbox';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';
import { serializeWorkspace, updateWorkspaceProfile } from '$lib/server/workspace';

export const GET: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);

  return json({
    ok: true,
    profile: session.profile,
    workspace: serializeWorkspace(session)
  });
};

export const PUT: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);
  const payload = (await event.request.json()) as UserProfile;
  const env = getRequestEnv(event);

  return json({
    ok: true,
    workspace: await updateWorkspaceProfile(env, session, payload)
  });
};
