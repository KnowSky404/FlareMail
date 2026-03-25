import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { LoginInput } from '$lib/mock/mailbox';
import {
  authenticateWorkspaceUser,
  clearSessionCookieOptions,
  destroyWorkspaceSession,
  serializeWorkspace,
  sessionCookieOptions,
  workspaceSessionCookie
} from '$lib/server/workspace';
import { getRequestEnv } from '$lib/server/workspace-api';

export const GET: RequestHandler = async ({ locals }) => {
  return json({
    ok: true,
    authenticated: Boolean(locals.workspaceSession),
    workspace: locals.workspaceSession ? serializeWorkspace(locals.workspaceSession) : null
  });
};

export const POST: RequestHandler = async (event) => {
  const payload = (await event.request.json()) as LoginInput;
  const env = getRequestEnv(event);
  const session = await authenticateWorkspaceUser(env, payload.email, payload.password);

  if (!session) {
    return json(
      {
        ok: false,
        error: '账号或密码错误。'
      },
      { status: 401 }
    );
  }

  event.cookies.set(workspaceSessionCookie, session.id, sessionCookieOptions(payload.remember));

  return json({
    ok: true,
    authenticated: true,
    workspace: serializeWorkspace(session)
  });
};

export const DELETE: RequestHandler = async (event) => {
  const env = getRequestEnv(event);
  await destroyWorkspaceSession(env, event.locals.workspaceSessionId);
  event.cookies.set(workspaceSessionCookie, '', clearSessionCookieOptions());

  return json({
    ok: true,
    authenticated: false,
    workspace: null
  });
};
