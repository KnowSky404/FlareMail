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

export const GET: RequestHandler = async ({ locals }) => {
  return json({
    ok: true,
    authenticated: Boolean(locals.workspaceSession),
    workspace: locals.workspaceSession ? serializeWorkspace(locals.workspaceSession) : null
  });
};

export const POST: RequestHandler = async ({ request, cookies }) => {
  const payload = (await request.json()) as LoginInput;
  const session = authenticateWorkspaceUser(payload.email, payload.password);

  if (!session) {
    return json(
      {
        ok: false,
        error: '演示账号或密码错误。'
      },
      { status: 401 }
    );
  }

  cookies.set(workspaceSessionCookie, session.id, sessionCookieOptions(payload.remember));

  return json({
    ok: true,
    authenticated: true,
    workspace: serializeWorkspace(session)
  });
};

export const DELETE: RequestHandler = async ({ locals, cookies }) => {
  destroyWorkspaceSession(locals.workspaceSessionId);
  cookies.set(workspaceSessionCookie, '', clearSessionCookieOptions());

  return json({
    ok: true,
    authenticated: false,
    workspace: null
  });
};
