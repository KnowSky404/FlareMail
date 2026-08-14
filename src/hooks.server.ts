import type { Handle } from '@sveltejs/kit';
import { validateCsrfOrigin } from '$lib/server/auth/csrf';
import { validateEnvironment } from '$lib/server/config/env';
import {
  getWorkspaceSession,
  workspaceSessionCookieNames
} from '$lib/server/workspace';
import { WorkspaceAuthUnavailableError } from '$lib/server/workspace/session';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { ApiError, apiFailure } from '$lib/server/http/api';

const setSecurityHeaders = (response: Response, secure: boolean) => {
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  response.headers.set('cross-origin-opener-policy', 'same-origin');
  if (secure) response.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
  return response;
};

export const handle: Handle = async ({ event, resolve }) => {
  const env = event.platform?.env as CloudflareEnv | undefined;
  const environment = validateEnvironment((env ?? {}) as unknown as Record<string, unknown>);
  if (!environment.ok && event.url.pathname !== '/api/health') {
    return new Response('Service configuration is incomplete.', { status: 503 });
  }
  const sessionToken = workspaceSessionCookieNames
    .map((name) => event.cookies.get(name))
    .find((value): value is string => Boolean(value)) ?? null;
  let session: Awaited<ReturnType<typeof getWorkspaceSession>> = null;
  try {
    session = await getWorkspaceSession(env, sessionToken);
  } catch (error) {
    if (error instanceof WorkspaceAuthUnavailableError && event.url.pathname !== '/api/health') {
      return setSecurityHeaders(new Response('Authentication storage is unavailable.', { status: 503 }), event.url.protocol === 'https:');
    }
    throw error;
  }

  event.locals.workspaceSessionToken = sessionToken;
  event.locals.workspaceSessionId = session?.id ?? null;
  event.locals.workspaceSession = session;

  const isApiMutation = event.url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(event.request.method.toUpperCase());
  const isSignedWebhook = event.url.pathname === '/api/webhooks/resend';
  if (isApiMutation && !isSignedWebhook) {
    const csrf = validateCsrfOrigin(event.request, { appOrigin: env?.APP_ORIGIN });
    if (!csrf.ok) {
      return setSecurityHeaders(apiFailure(
        event,
        new ApiError(403, 'CSRF_ORIGIN_REJECTED', '请求来源验证失败。')
      ), event.url.protocol === 'https:');
    }
  }

  try {
    return setSecurityHeaders(await resolve(event), event.url.protocol === 'https:');
  } catch (error) {
    if (error instanceof ApiError) {
      return setSecurityHeaders(apiFailure(event, error), event.url.protocol === 'https:');
    }
    throw error;
  }
};
