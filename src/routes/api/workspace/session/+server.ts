import type { RequestHandler } from './$types';
import type { LoginInput } from '$lib/domain/mail';
import { clearLoginAttempts, consumeLoginAttempt } from '$lib/server/auth/rate-limit';
import { normalizeLoginEmail } from '$lib/server/auth/rate-limit';
import { ApiError, apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import {
  authenticateWorkspaceUser,
  clearSessionCookieOptions,
  destroyWorkspaceSession,
  getWorkspaceSessionCookieName,
  isSecureSessionRequest,
  legacyWorkspaceSessionCookie,
  loadWorkspaceSnapshot,
  sessionCookieOptions,
  secureWorkspaceSessionCookie,
  WorkspaceAuthUnavailableError,
  workspaceSessionCookie
} from '$lib/server/workspace';
import { getRequestEnv } from '$lib/server/workspace-api';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const env = getRequestEnv(event);
  const snapshot = event.locals.workspaceSession && env?.DB
    ? await loadWorkspaceSnapshot(env, event.locals.workspaceSession)
    : null;
  return apiSuccess(event, {
    authenticated: Boolean(event.locals.workspaceSession),
    workspace: snapshot?.workspace ?? null
  });
});

export const POST: RequestHandler = withApiHandler(async (event) => {
  const payload = await readJsonBody<LoginInput>(event, { maxBytes: 8 * 1024 });
  if (
    !payload ||
    typeof payload.email !== 'string' ||
    typeof payload.password !== 'string' ||
    payload.email.length > 320 ||
    payload.password.length > 1024
  ) throw new ApiError(400, 'INVALID_LOGIN_INPUT', '请提供有效的登录信息。');

  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'AUTHENTICATION_UNAVAILABLE', '当前运行环境尚未完成认证配置。');
  const clientAddress = event.request.headers.get('CF-Connecting-IP') ??
    event.request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';
  const normalizedEmail = normalizeLoginEmail(payload.email);
  const attemptKey = `${clientAddress}:${normalizedEmail}`;
  const rateLimit = await consumeLoginAttempt(env.DB, attemptKey);
  if (!rateLimit.allowed) {
    throw new ApiError(429, 'LOGIN_RATE_LIMITED', `登录尝试过多，请在 ${rateLimit.retryAfterSeconds} 秒后重试。`);
  }

  let authenticated;
  try {
    authenticated = await authenticateWorkspaceUser(env, payload.email, payload.password, Boolean(payload.remember));
  } catch (error) {
    if (error instanceof WorkspaceAuthUnavailableError) {
      throw new ApiError(503, 'AUTHENTICATION_UNAVAILABLE', '当前运行环境尚未完成认证配置。');
    }
    throw error;
  }
  if (!authenticated) throw new ApiError(401, 'INVALID_CREDENTIALS', '账号或密码错误。');

  await clearLoginAttempts(env.DB, attemptKey);
  const secure = isSecureSessionRequest(event.url, env);
  const cookieName = getWorkspaceSessionCookieName(secure);
  event.cookies.set(cookieName, authenticated.token, sessionCookieOptions(Boolean(payload.remember), secure));
  if (cookieName !== workspaceSessionCookie) event.cookies.delete(workspaceSessionCookie, clearSessionCookieOptions(false));
  event.cookies.delete(legacyWorkspaceSessionCookie, clearSessionCookieOptions(false));

  return apiSuccess(event, {
    authenticated: true,
    workspace: (await loadWorkspaceSnapshot(env!, authenticated.session)).workspace
  });
});

export const DELETE: RequestHandler = withApiHandler(async (event) => {
  await destroyWorkspaceSession(getRequestEnv(event), event.locals.workspaceSessionToken);
  event.cookies.delete(secureWorkspaceSessionCookie, clearSessionCookieOptions(true));
  event.cookies.delete(workspaceSessionCookie, clearSessionCookieOptions(false));
  event.cookies.delete(legacyWorkspaceSessionCookie, clearSessionCookieOptions(false));
  return apiSuccess(event, { authenticated: false, workspace: null });
});
