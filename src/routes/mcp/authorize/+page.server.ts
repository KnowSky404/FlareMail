import { fail, redirect } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { consumeLoginAttempt } from '$lib/server/auth/rate-limit';
import { validateCsrfOrigin } from '$lib/server/auth/csrf';
import { mcpScopes, mcpScopeMask, scopesFromMask } from '$lib/domain/mail/mcp';
import { getRequestEnv } from '$lib/server/workspace-api';
import { isAllowedRedirect, isMcpOwnerConfiguration, mcpConfig, mcpPaths } from '$lib/server/mcp/config';
import { boundedMcpBody, requireContentType } from '$lib/server/mcp/http';
import { addPendingGrant, consumeConsent, credentialDigest, ownerPolicy, startConsent } from '$lib/server/mcp/store';

async function consentContext(event: RequestEvent) {
  const env = getRequestEnv(event);
  const config = env && mcpConfig(env);
  if (!env?.OAUTH_KV || !config || event.url.origin !== config.issuer || event.url.pathname !== mcpPaths.authorize) return null;
  // The provider uses WorkerEntrypoint, which is unavailable during SvelteKit's Node route analysis.
  const { AuthorizationError, authorizationErrorRedirect, createMcpAuthorizationServer } = await import('$lib/server/mcp/oauth');
  const oauth = createMcpAuthorizationServer(config).getOAuthApi({ ...env, OAUTH_KV: env.OAUTH_KV });
  return { env, config, oauth, AuthorizationError, authorizationErrorRedirect };
}

function cookieFrom(headers: Headers) {
  return /^(__Host-oauth-consent[^=]*)=([^;]*)/u.exec(headers.get('set-cookie') ?? '');
}

export const load: PageServerLoad = async (event) => {
  const context = await consentContext(event);
  if (!context) return { status: 'unavailable' as const };
  const { env, config, oauth, AuthorizationError } = context;
  const session = event.locals.workspaceSession;
  if (!session) {
    return event.locals.authMode === 'local'
      ? { status: 'login' as const, authConfigured: event.locals.authConfigured ?? false }
      : { status: 'unavailable' as const };
  }
  if (!isMcpOwnerConfiguration(env, session.userId)) return { status: 'unavailable' as const };

  try {
    const policy = await ownerPolicy(env.DB, session.userId);
    if (!policy?.enabled) return { status: 'unavailable' as const };
    const rate = await consumeLoginAttempt(env.DB, `mcp:authorize:${session.userId}`, Date.now(), 30, 60_000);
    if (!rate.allowed) return { status: 'unavailable' as const };
    const params = event.url.searchParams;
    if (event.url.search.length > 4096 || [...params.keys()].some((key) => params.getAll(key).length !== 1) ||
        (params.has('resource') && params.get('resource') !== config.resource) ||
        params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/u.test(params.get('code_challenge') ?? '') ||
        !params.get('state') || !params.get('redirect_uri') || !isAllowedRedirect(params.get('redirect_uri')!, config)) {
      return { status: 'invalid' as const };
    }
    const request = await oauth.parseAuthRequest(event.request);
    if (request.issuer !== config.issuer || request.resource !== config.resource ||
        request.scope.some((scope) => !mcpScopes.some((allowed) => allowed === scope))) return { status: 'invalid' as const };
    const requested = request.scope.length ? mcpScopeMask(request.scope) : 3;
    const scopes = scopesFromMask(policy.scopes & requested);
    if (scopes.length === 0) return { status: 'unavailable' as const };
    const { clientName, redirectHost, redirectIsLoopback } = await oauth.describeConsent(request);
    const transaction = await oauth.beginConsent(request);
    const cookie = cookieFrom(transaction.headers);
    if (!cookie) return { status: 'unavailable' as const };
    await startConsent(env.DB, await credentialDigest(transaction.handle + ':' + session.id), session.userId, policy.revision);
    event.cookies.set(cookie[1]!, cookie[2]!, { path: '/', secure: true, httpOnly: true, sameSite: 'lax', maxAge: 600 });
    return { status: 'consent' as const, clientName, redirectHost, redirectIsLoopback, scopes, handle: transaction.handle };
  } catch (error) {
    return { status: error instanceof AuthorizationError ? 'invalid' as const : 'unavailable' as const };
  }
};

export const actions: Actions = {
  default: async (event) => {
    const context = await consentContext(event);
    const session = event.locals.workspaceSession;
    if (!context || !session || !isMcpOwnerConfiguration(context.env, session.userId)) return fail(403, { reason: 'unavailable' });
    if (!validateCsrfOrigin(event.request).ok) return fail(403, { reason: 'invalid' });
    const { env, config, oauth, AuthorizationError, authorizationErrorRedirect } = context;
    let destination: string;
    try {
      requireContentType(event.request, 'application/x-www-form-urlencoded');
      const signal = AbortSignal.any([event.request.signal, AbortSignal.timeout(10_000)]);
      const fields = new URLSearchParams(await boundedMcpBody(event.request, 4096, signal));
      const handle = fields.get('handle');
      const decision = fields.get('decision');
      const selected = fields.getAll('scope');
      if (!handle || !/^[A-Za-z0-9_-]{43}$/u.test(handle) || !['approve', 'deny'].some((value) => value === decision) ||
          selected.some((scope) => !mcpScopes.some((allowed) => allowed === scope))) return fail(400, { reason: 'invalid' });
      const policy = await ownerPolicy(env.DB, session.userId);
      if (!policy?.enabled || !(await consumeConsent(env.DB, await credentialDigest(handle + ':' + session.id), session.userId, policy.revision))) {
        return fail(400, { reason: 'invalid' });
      }
      if (decision === 'deny') {
        const denied = await oauth.denyConsent(event.request, handle);
        const cookie = cookieFrom(denied.headers);
        if (cookie) event.cookies.delete(cookie[1]!, { path: '/', secure: true, sameSite: 'lax' });
        destination = isAllowedRedirect(denied.request.redirectUri, config) ? denied.redirectTo : '/?folder=settings&tab=integrations';
      } else {
        const approved = await oauth.approveConsent(event.request, handle);
        const cookie = cookieFrom(approved.headers);
        if (cookie) event.cookies.delete(cookie[1]!, { path: '/', secure: true, sameSite: 'lax' });
        const auth = approved.request;
        if (auth.issuer !== config.issuer || auth.resource !== config.resource || !isAllowedRedirect(auth.redirectUri, config)) return fail(400, { reason: 'invalid' });
        const requested = auth.scope.length ? mcpScopeMask(auth.scope) : 3;
        const scopes = policy.scopes & requested & mcpScopeMask(selected);
        if (!scopes) {
          destination = authorizationErrorRedirect(auth, 'access_denied');
        } else {
          const id = crypto.randomUUID();
          const { clientName } = await oauth.describeConsent(auth);
          const { redirectTo } = await oauth.completeAuthorization({
            request: auth, userId: session.userId, metadata: {}, scope: scopesFromMask(scopes),
            props: { id, issuer: config.issuer }, revokeExistingGrants: false
          });
          const code = new URL(redirectTo).searchParams.get('code');
          if (!code || !(await addPendingGrant(env.DB, {
            id, owner: session.userId, issuer: config.issuer, client: auth.clientId,
            name: clientName, scopes, revision: policy.revision, code
          }))) return fail(409, { reason: 'invalid' });
          destination = redirectTo;
        }
      }
    } catch (error) {
      return error instanceof AuthorizationError ? fail(400, { reason: 'invalid' }) : fail(503, { reason: 'unavailable' });
    }
    redirect(303, destination);
  }
};
