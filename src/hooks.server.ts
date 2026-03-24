import type { Handle } from '@sveltejs/kit';
import { getWorkspaceSession, workspaceSessionCookie } from '$lib/server/workspace';
import type { CloudflareEnv } from '$lib/server/cloudflare';

export const handle: Handle = async ({ event, resolve }) => {
  const sessionId = event.cookies.get(workspaceSessionCookie) ?? null;
  const env = event.platform?.env as CloudflareEnv | undefined;

  event.locals.workspaceSessionId = sessionId;
  event.locals.workspaceSession = await getWorkspaceSession(env, sessionId);

  return resolve(event);
};
