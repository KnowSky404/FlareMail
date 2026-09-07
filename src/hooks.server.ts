import type { Handle, HandleServerError } from '@sveltejs/kit';
import { validateCsrfOrigin } from '$lib/server/auth/csrf';
import { validateEnvironment } from '$lib/server/config/env';
import { hasWorkspaceCoreTables } from '$lib/server/db/capabilities';
import {
  getWorkspaceSession,
  isSecureSessionRequest,
  legacyWorkspaceSessionCookie,
  secureWorkspaceSessionCookie,
  workspaceSessionCookie
} from '$lib/server/workspace';
import { WorkspaceAuthUnavailableError } from '$lib/server/workspace/session';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { ApiError, apiFailure, classifyRuntimeError, getRequestId, runtimeUnavailableState } from '$lib/server/http/api';

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

export const handle: Handle = async ({ event, resolve }) => {
  const requestId = getRequestId(event);
  const env = event.platform?.env as CloudflareEnv | undefined;
  const isHealth = event.url.pathname === '/api/health';
  const isApi = event.url.pathname.startsWith('/api/');
  const secure = event.url.protocol === 'https:';
  const failApi = (error: ApiError) => setSecurityHeaders(apiFailure(event, error), secure);
  const markUnavailable = (error: unknown) => {
    event.locals.runtimeState = runtimeUnavailableState(error, requestId);
  };
  const environment = validateEnvironment((env ?? {}) as unknown as Record<string, unknown>);
  if (!environment.ok && !isHealth) {
    const error = new ApiError(503, 'CONFIG_INVALID', '服务配置尚未完成。', undefined, undefined, false);
    markUnavailable(error);
    if (isApi) return failApi(error);
  }
  let session: Awaited<ReturnType<typeof getWorkspaceSession>> = null;
  const sessionToken = sessionCookieNamesForRequest(event.url)
    .map((name) => event.cookies.get(name))
    .find((value): value is string => Boolean(value)) ?? null;

  if (!isHealth && environment.ok) {
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
        session = await getWorkspaceSession(env, sessionToken);
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

  const isApiMutation = event.url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(event.request.method.toUpperCase());
  const isSignedWebhook = event.url.pathname === '/api/webhooks/resend';
  if (isApiMutation && !isSignedWebhook) {
    const csrf = validateCsrfOrigin(event.request);
    if (!csrf.ok) {
      return setSecurityHeaders(apiFailure(
        event,
        new ApiError(403, 'CSRF_ORIGIN_REJECTED', '请求来源验证失败。')
      ), secure, requestId);
    }
  }

  try {
    return setSecurityHeaders(await resolve(event), secure, requestId);
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
