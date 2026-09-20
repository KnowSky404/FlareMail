import type { Handle, HandleServerError } from '@sveltejs/kit';
import { validateCsrfOrigin } from '$lib/server/auth/csrf';
import { validateEnvironment } from '$lib/server/config/env';
import { hasWorkspaceCoreTables } from '$lib/server/db/capabilities';
import {
  getWorkspaceSessionCookieName,
  getWorkspaceSession,
  isSecureSessionRequest,
  legacyWorkspaceSessionCookie,
  sessionCookieOptions,
  secureWorkspaceSessionCookie,
  workspaceSessionCookie
} from '$lib/server/workspace';
import { createAccessWorkspaceSession, WorkspaceAuthUnavailableError } from '$lib/server/workspace/session';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { ApiError, apiFailure, classifyRuntimeError, getRequestId, runtimeUnavailableState } from '$lib/server/http/api';
import { resolveLocale } from '$lib/client/locale-preferences';
import { verifyCloudflareAccessAssertion } from '$lib/server/auth/cloudflare-access';
import { findWorkspaceOwnerId, hasWorkspaceOwnerCredential } from '$lib/server/db/users';

const setSecurityHeaders = (response: Response, secure: boolean, requestId?: string) => {
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  response.headers.set('cross-origin-opener-policy', 'same-origin');
  if (requestId) response.headers.set('x-request-id', requestId);
  if (secure) response.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
  return response;
};

/** Do not accept a non-Host session cookie on a request that is externally HTTPS. */
export function sessionCookieNamesForRequest(url: URL): readonly string[] {
  return isSecureSessionRequest(url)
    ? [secureWorkspaceSessionCookie]
    : [workspaceSessionCookie, legacyWorkspaceSessionCookie];
}

export const isPrivateReaderPath = (pathname: string): boolean => pathname.startsWith('/messages/');

export const isAccessExemptPath = (pathname: string): boolean =>
  pathname === '/api/health' || pathname === '/api/webhooks/resend' || pathname === '/api/webhooks/telegram';

export const handle: Handle = async ({ event, resolve }) => {
  const requestId = getRequestId(event);
  const env = event.platform?.env as CloudflareEnv | undefined;
  const isResendWebhook = event.url.pathname === '/api/webhooks/resend';
  const isTelegramWebhook = event.url.pathname === '/api/webhooks/telegram';
  const isSignedWebhook = isResendWebhook || isTelegramWebhook;
  const isAccessExempt = isAccessExemptPath(event.url.pathname);
  const isApi = event.url.pathname.startsWith('/api/');
  const secure = event.url.protocol === 'https:';
  const locale = resolveLocale({
    cookie: event.cookies.get('flaremail-locale') ?? null,
    acceptLanguage: event.request.headers.get('accept-language')
  });
  event.locals.locale = locale;
  const failApi = (error: ApiError) => setSecurityHeaders(apiFailure(event, error), secure);
  const markUnavailable = (error: unknown) => {
    event.locals.runtimeState = runtimeUnavailableState(error, requestId);
  };
  const environment = validateEnvironment((env ?? {}) as unknown as Record<string, unknown>);
  // These exact machine/public paths have their own validation. The signed
  // webhook handlers verify provider credentials before parsing request data.
  if (!environment.ok && !isAccessExempt) {
    const error = new ApiError(503, 'CONFIG_INVALID', '服务配置尚未完成。', undefined, undefined, false);
    markUnavailable(error);
    if (isApi) return failApi(error);
    return setSecurityHeaders(new Response('Service configuration is unavailable.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' }
    }), secure, requestId);
  }

  let accessPrincipalId: string | null = null;
  let accessExpiresAt: number | null = null;
  if (!isAccessExempt && environment.ok && environment.config.authMode === 'cloudflare-access') {
    const verified = await verifyCloudflareAccessAssertion(
      event.request.headers.get('cf-access-jwt-assertion'),
      {
        issuer: environment.config.accessIssuer!,
        audience: environment.config.accessAudience!,
        jwksUrl: environment.config.accessJwksUrl!,
        allowedSubject: environment.config.accessAllowedSubject!
      }
    );
    if (verified.status === 'invalid') {
      if (isApi) return setSecurityHeaders(apiFailure(event,
        new ApiError(401, 'ACCESS_REQUIRED', '需要有效的 Cloudflare Access 身份。')), secure, requestId);
      return setSecurityHeaders(new Response('Authentication required.', {
        status: 401,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' }
      }), secure, requestId);
    }
    if (verified.status === 'unavailable') {
      const error = new ApiError(503, 'ACCESS_UNAVAILABLE', 'Cloudflare Access 身份验证暂时不可用。');
      markUnavailable(error);
      console.error(JSON.stringify({ level: 'error', event: 'access_jwks_unavailable', requestId }));
      if (isApi) return failApi(error);
      return setSecurityHeaders(new Response('Authentication is temporarily unavailable.', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' }
      }), secure, requestId);
    }
    accessPrincipalId = verified.subject;
    accessExpiresAt = verified.expiresAt;
  }

  let session: Awaited<ReturnType<typeof getWorkspaceSession>> = null;
  let authConfigured = false;
  let sessionToken = sessionCookieNamesForRequest(event.url)
    .map((name) => event.cookies.get(name))
    .find((value): value is string => Boolean(value)) ?? null;

  if (!isAccessExempt && environment.ok) {
    try {
      if (!env?.DB) {
        const error = new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
        markUnavailable(error);
        if (isApi) return failApi(error);
      } else if (!(await hasWorkspaceCoreTables(env))) {
        const error = new ApiError(503, 'SCHEMA_NOT_READY', '服务数据结构尚未就绪。');
        markUnavailable(error);
        if (isApi) return failApi(error);
      } else {
        if (environment.config.authMode === 'cloudflare-access') {
          const ownerId = environment.config.accessOwnerUserId!;
          const mappedOwnerId = await findWorkspaceOwnerId(env.DB);
          if (mappedOwnerId !== ownerId) {
            const error = new ApiError(503, 'OWNER_MAPPING_REQUIRED', '工作区 Owner 尚未初始化或与受信配置不匹配。');
            markUnavailable(error);
            if (isApi) return failApi(error);
            return setSecurityHeaders(new Response('Owner mapping is not ready.', {
              status: 503,
              headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' }
            }), secure, requestId);
          } else if (accessPrincipalId && accessExpiresAt) {
            authConfigured = true;
            session = await getWorkspaceSession(env, sessionToken, {
              authMethod: 'cloudflare-access',
              principalId: accessPrincipalId
            });
            if (!session) {
              const authenticated = await createAccessWorkspaceSession(
                env,
                ownerId,
                accessPrincipalId,
                accessExpiresAt
              );
              session = authenticated.session;
              sessionToken = authenticated.token;
              const cookieName = getWorkspaceSessionCookieName(secure);
              const maxAgeSeconds = Math.max(1, Math.floor((Date.parse(authenticated.expiresAt) - Date.now()) / 1000));
              event.cookies.set(cookieName, authenticated.token, sessionCookieOptions(false, secure, maxAgeSeconds));
              if (cookieName !== workspaceSessionCookie) event.cookies.delete(workspaceSessionCookie, { path: '/', maxAge: 0 });
              event.cookies.delete(legacyWorkspaceSessionCookie, { path: '/', maxAge: 0 });
            }
          }
        } else {
          session = await getWorkspaceSession(env, sessionToken, { authMethod: 'local' });
          authConfigured = Boolean(session) || await hasWorkspaceOwnerCredential(env.DB);
        }
      }
    } catch (error) {
      const classified = error instanceof WorkspaceAuthUnavailableError
        ? new ApiError(503, 'AUTHENTICATION_UNAVAILABLE', '认证存储暂时不可用。')
        : classifyRuntimeError(error);
      markUnavailable(classified);
      if (isApi) return failApi(classified);
    }
  }

  event.locals.workspaceSessionToken = sessionToken;
  event.locals.workspaceSessionId = session?.id ?? null;
  event.locals.workspaceSession = session;
  event.locals.authMode = environment.config.authMode;
  event.locals.authPrincipalId = accessPrincipalId;
  event.locals.authConfigured = authConfigured;

  const isApiMutation = event.url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(event.request.method.toUpperCase());
  if (isApiMutation && !isSignedWebhook && !isTelegramWebhook) {
    const csrf = validateCsrfOrigin(event.request);
    if (!csrf.ok) {
      return setSecurityHeaders(apiFailure(
        event,
        new ApiError(403, 'CSRF_ORIGIN_REJECTED', '请求来源验证失败。')
      ), secure, requestId);
    }
  }

  try {
    const response = await resolve(event, {
      transformPageChunk: ({ html }) => html.replace(/<html lang="(?:zh-CN|en)">/u, `<html lang="${locale}">`)
    });
    if (isPrivateReaderPath(event.url.pathname) || !isAccessExempt) {
      response.headers.set('cache-control', 'private, no-store');
    }
    return setSecurityHeaders(response, secure, requestId);
  } catch (error) {
    if (error instanceof ApiError) {
      return failApi(error);
    }
    if (isApi) {
      const classified = classifyRuntimeError(error);
      console.error(JSON.stringify({
        level: 'error',
        event: 'api_request_failed',
        requestId,
        method: event.request.method,
        path: event.url.pathname,
        code: classified.code,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      }));
      return failApi(classified);
    }
    throw error;
  }
};

export const handleError: HandleServerError = ({ error, event, status }) => {
  const requestId = getRequestId(event);
  console.error(JSON.stringify({
    level: 'error',
    event: 'request_failed',
    requestId,
    method: event.request.method,
    path: event.url.pathname,
    status,
    errorName: error instanceof Error ? error.name : 'UnknownError'
  }));
  return {
    message: '服务器暂时无法完成请求。',
    requestId
  };
};
