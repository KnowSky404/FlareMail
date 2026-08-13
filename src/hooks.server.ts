import type { Handle } from '@sveltejs/kit';
import { validateCsrfOrigin } from '$lib/server/auth/csrf';
import { validateEnvironment } from '$lib/server/config/env';
import {
  getWorkspaceSession,
  workspaceSessionCookieNames
} from '$lib/server/workspace';
import type { CloudflareEnv } from '$lib/server/cloudflare';

export const handle: Handle = async ({ event, resolve }) => {
  const env = event.platform?.env as CloudflareEnv | undefined;
  const environment = validateEnvironment((env ?? {}) as unknown as Record<string, unknown>);
  if (!environment.ok && event.url.pathname !== '/api/health') {
    return new Response('Service configuration is incomplete.', { status: 503 });
  }
  const sessionToken = workspaceSessionCookieNames
    .map((name) => event.cookies.get(name))
    .find((value): value is string => Boolean(value)) ?? null;
  const session = await getWorkspaceSession(env, sessionToken);

  event.locals.workspaceSessionToken = sessionToken;
  event.locals.workspaceSessionId = session?.id ?? null;
  event.locals.workspaceSession = session;

  const isApiMutation = event.url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(event.request.method.toUpperCase());
  const isSignedWebhook = event.url.pathname === '/api/webhooks/resend';
  if (isApiMutation && !isSignedWebhook) {
    const csrf = validateCsrfOrigin(event.request, { appOrigin: env?.APP_ORIGIN });
    if (!csrf.ok) {
      return new Response(JSON.stringify({ ok: false, error: 'Request origin validation failed.' }), {
        status: 403,
        headers: { 'content-type': 'application/json; charset=utf-8' }
      });
    }
  }

  return resolve(event);
};
