import type { RequestHandler } from './$types';
import type { LoginInput } from '$lib/domain/mail';
import { clearLoginAttempts, consumeLoginAttempt } from '$lib/server/auth/rate-limit';
import { isValidLoginUsername, normalizeLoginUsername } from '$lib/server/auth/rate-limit';
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
  WorkspaceAuthNotConfiguredError,
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
    authMode: event.locals.authMode ?? 'local',
    authConfigured: event.locals.authConfigured ?? false,
    workspace: snapshot?.workspace ?? null
  });
});

export const POST: RequestHandler = withApiHandler(async (event) => {
  const env = getRequestEnv(event);
  if (env?.AUTH_MODE?.trim().toLowerCase() === 'cloudflare-access') {
    throw new ApiError(403, 'LOCAL_LOGIN_DISABLED', '此部署仅通过 Cloudflare Access 登录。');
  }
  const payload = await readJsonBody<LoginInput>(event, { maxBytes: 8 * 1024 });
  if (
    !payload ||
    typeof payload.username !== 'string' ||
    typeof payload.password !== 'string' ||
    payload.username.length > 128 ||
    payload.password.length > 1024
  ) throw new ApiError(400, 'INVALID_LOGIN_INPUT', '请提供有效的用户名和密码。');

  const normalizedUsername = normalizeLoginUsername(payload.username);
  if (!isValidLoginUsername(normalizedUsername)) {
    throw new ApiError(400, 'INVALID_LOGIN_INPUT', '用户名长度或字符不符合要求。');
  }
  if (!env?.DB) throw new ApiError(503, 'AUTHENTICATION_UNAVAILABLE', '当前运行环境尚未完成认证配置。');
  const clientAddress = event.request.headers.get('CF-Connecting-IP') ??
    event.request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';
  const attemptKey = `${clientAddress}:${normalizedUsername}`;
  const rateLimit = await consumeLoginAttempt(env.DB, attemptKey);
  if (!rateLimit.allowed) {
    throw new ApiError(429, 'LOGIN_RATE_LIMITED', `登录尝试过多，请在 ${rateLimit.retryAfterSeconds} 秒后重试。`);
  }

  let authenticated;
  try {
    authenticated = await authenticateWorkspaceUser(env, normalizedUsername, payload.password, Boolean(payload.remember));
  } catch (error) {
    if (error instanceof WorkspaceAuthNotConfiguredError) {
      throw new ApiError(503, 'AUTH_CONFIGURATION_INCOMPLETE', '本地 Owner 登录凭据尚未配置。');
    }
    if (error instanceof WorkspaceAuthUnavailableError) {
      throw new ApiError(503, 'AUTHENTICATION_UNAVAILABLE', '当前运行环境尚未完成认证配置。');
    }
    throw error;
  }
  if (!authenticated) throw new ApiError(401, 'INVALID_CREDENTIALS', '账号或密码错误。');

  await clearLoginAttempts(env.DB, attemptKey);
  const secure = isSecureSessionRequest(event.url);
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
  const revoked = await destroyWorkspaceSession(getRequestEnv(event), event.locals.workspaceSessionToken);
  event.cookies.delete(secureWorkspaceSessionCookie, clearSessionCookieOptions(true));
  event.cookies.delete(workspaceSessionCookie, clearSessionCookieOptions(false));
  event.cookies.delete(legacyWorkspaceSessionCookie, clearSessionCookieOptions(false));
  if (!revoked) throw new ApiError(503, 'SESSION_REVOCATION_UNAVAILABLE', '退出登录暂时无法完成，请稍后重试。');
  return apiSuccess(event, {
    authenticated: false,
    workspace: null,
    ...(event.locals.authMode === 'cloudflare-access'
      ? { logoutUrl: '/cdn-cgi/access/logout' }
      : {})
  });
});
