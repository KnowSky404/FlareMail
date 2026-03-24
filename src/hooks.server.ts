import type { Handle } from '@sveltejs/kit';
import { getWorkspaceSession, workspaceSessionCookie } from '$lib/server/workspace';

export const handle: Handle = async ({ event, resolve }) => {
  const sessionId = event.cookies.get(workspaceSessionCookie) ?? null;

  event.locals.workspaceSessionId = sessionId;
  event.locals.workspaceSession = getWorkspaceSession(sessionId);

  return resolve(event);
};
