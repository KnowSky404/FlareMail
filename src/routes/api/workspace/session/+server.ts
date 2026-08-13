import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { LoginInput } from '$lib/domain/mail';
import { clearLoginAttempts, consumeLoginAttempt } from '$lib/server/auth/rate-limit';
import {
  authenticateWorkspaceUser,
  clearSessionCookieOptions,
  destroyWorkspaceSession,
  getWorkspaceSessionCookieName,
  isSecureSessionRequest,
  legacyWorkspaceSessionCookie,
  serializeWorkspace,
  sessionCookieOptions,
  secureWorkspaceSessionCookie,
  WorkspaceAuthUnavailableError,
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
  let payload: LoginInput;
  try {
    payload = (await event.request.json()) as LoginInput;
  } catch {
    return json({ ok: false, error: '请提供有效的登录信息。' }, { status: 400 });
  }
  if (!payload || typeof payload.email !== 'string' || typeof payload.password !== 'string') {
    return json({ ok: false, error: '请提供有效的登录信息。' }, { status: 400 });
  }
  if (payload.email.length > 320 || payload.password.length > 1024) {
    return json({ ok: false, error: '请提供有效的登录信息。' }, { status: 400 });
  }

  const env = getRequestEnv(event);
  const clientAddress = event.request.headers.get('CF-Connecting-IP') ?? event.request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';
  const attemptKey = `${clientAddress}:${payload.email}`;
  const rateLimit = consumeLoginAttempt(attemptKey);
  if (!rateLimit.allowed) {
    return json({ ok: false, error: '登录尝试过多，请稍后再试。' }, {
      status: 429,
      headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) }
    });
  }

  let authenticated;
  try {
    authenticated = await authenticateWorkspaceUser(env, payload.email, payload.password, Boolean(payload.remember));
  } catch (error) {
    if (error instanceof WorkspaceAuthUnavailableError) {
      return json({ ok: false, error: '当前运行环境尚未完成认证配置。' }, { status: 503 });
    }
    throw error;
  }

  if (!authenticated) {
    return json(
      {
        ok: false,
        error: '账号或密码错误。'
      },
      { status: 401 }
    );
  }

  clearLoginAttempts(attemptKey);
  const secure = isSecureSessionRequest(event.url, env);
  const cookieName = getWorkspaceSessionCookieName(secure);
  event.cookies.set(cookieName, authenticated.token, sessionCookieOptions(Boolean(payload.remember), secure));
  if (cookieName !== workspaceSessionCookie) event.cookies.delete(workspaceSessionCookie, clearSessionCookieOptions(false));
  event.cookies.delete(legacyWorkspaceSessionCookie, clearSessionCookieOptions(false));

  return json({
    ok: true,
    authenticated: true,
    workspace: serializeWorkspace(authenticated.session)
  });
};

export const DELETE: RequestHandler = async (event) => {
  const env = getRequestEnv(event);
  await destroyWorkspaceSession(env, event.locals.workspaceSessionToken);
  event.cookies.delete(secureWorkspaceSessionCookie, clearSessionCookieOptions(true));
  event.cookies.delete(workspaceSessionCookie, clearSessionCookieOptions(false));
  event.cookies.delete(legacyWorkspaceSessionCookie, clearSessionCookieOptions(false));

  return json({
    ok: true,
    authenticated: false,
    workspace: null
  });
};
