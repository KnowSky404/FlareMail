import type { CloudflareEnv } from '$lib/server/cloudflare';
import { consumeLoginAttempt } from '$lib/server/auth/rate-limit';
import { mcpScopeMask, scopesFromMask } from '$lib/domain/mail/mcp';
import { isMcpOwnerConfiguration, mcpConfig, mcpPaths } from './config';
import { boundedMcpBody, McpHttpError, privateMcpResponse, requireContentType } from './http';
import { createMcpAuthorizationServer, exchangeFor, isGrantProps, type GrantProps } from './oauth';
import { activeAccess, credentialDigest, ownerPolicy, recordTokenIssue, revokeIssuedCredential, revokeReplayedExchange } from './store';
import { serveMcpTools } from './server';

const readMethods = ['GET', 'HEAD'];
const timeoutMs = 10_000;

export async function handleMcpEndpoint(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const requestId = crypto.randomUUID();
  const finish = (response: Response) => privateMcpResponse(response, requestId);
  const error = (status: number, code: string, headers?: HeadersInit) =>
    finish(Response.json({ error: code }, { status, headers }));
  const config = mcpConfig(env);
  if (!config || !env.OAUTH_KV || url.origin !== config.issuer) return error(404, 'not_found');
  if (url.search || (request.headers.has('origin') && request.headers.get('origin') !== config.issuer)) {
    return error(403, 'forbidden');
  }
  const bindings = { ...env, OAUTH_KV: env.OAUTH_KV };
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
  const path = url.pathname;
  const isResource = path === mcpPaths.resource;
  const isMetadata = path === mcpPaths.issuerMetadata || path === mcpPaths.protectedResource || path === mcpPaths.protectedResourceRoot;
  const methods = isMetadata ? readMethods : ['POST'];
  if (!methods.includes(request.method)) return error(405, 'method_not_allowed', { allow: methods.join(', ') });

  try {
    const policy = await ownerPolicy(env.DB);
    if (!policy?.enabled) return error(404, 'not_found');
    const metadataUrl = config.issuer + mcpPaths.protectedResource;
    if (path === mcpPaths.protectedResource || path === mcpPaths.protectedResourceRoot) {
      return finish(new Response(request.method === 'HEAD' ? null : JSON.stringify({
        resource: config.resource,
        authorization_servers: [config.issuer],
        scopes_supported: scopesFromMask(policy.scopes),
        bearer_methods_supported: ['header'],
        resource_name: 'FlareMail'
      }), { headers: { 'content-type': 'application/json' } }));
    }
    const authorization = createMcpAuthorizationServer(config);
    if (isMetadata) return finish(await authorization.fetch(request, bindings, ctx));

    const key = request.headers.get('cf-connecting-ip') ?? 'local';
    const rate = await consumeLoginAttempt(env.DB, `mcp:${path}:${key}`, Date.now(),
      path === mcpPaths.register ? 10 : isResource ? 120 : 30, 60_000);
    if (!rate.allowed) return error(429, 'rate_limit_exceeded', { 'retry-after': String(rate.retryAfterSeconds) });

    if (isResource) {
      const challenge = (reason?: string) => error(401, reason ?? 'authentication_required', {
        'www-authenticate': `Bearer resource_metadata="${metadataUrl}"${reason ? ', error="invalid_token"' : ''}`
      });
      const token = /^Bearer ([^\s,]{1,512})$/iu.exec(request.headers.get('authorization') ?? '')?.[1];
      if (!token) return challenge();
      const validated = await authorization.validateToken<GrantProps>(config.resource, token, bindings);
      if (!validated || validated.audience !== config.resource || !isGrantProps(validated.props) ||
          validated.props.issuer !== config.issuer || !isMcpOwnerConfiguration(env, validated.userId)) {
        return challenge('invalid_token');
      }
      const digest = await credentialDigest(token);
      const grantKey = { id: validated.props.id, owner: validated.userId, issuer: config.issuer, client: validated.clientId };
      const grant = await activeAccess(env.DB, grantKey, digest);
      if (!grant) return challenge('invalid_token');
      const grantRate = await consumeLoginAttempt(env.DB, `mcp:grant:${grant.id}`, Date.now(), 60, 60_000);
      if (!grantRate.allowed) return error(429, 'rate_limit_exceeded', { 'retry-after': String(grantRate.retryAfterSeconds) });
      requireContentType(request, 'application/json');
      const text = await boundedMcpBody(request, 16 * 1024, signal);
      const sanitized = new Request(request.url, {
        method: 'POST', body: text, signal, headers: request.headers
      });
      return finish(await serveMcpTools(sanitized, {
        env, grant, grantKey, digest, tokenScopes: mcpScopeMask(validated.scope), config, requestId, signal
      }));
    }

    requireContentType(request, path === mcpPaths.token ? 'application/x-www-form-urlencoded' : 'application/json');
    const body = await boundedMcpBody(request, 8 * 1024, signal);
    const sanitized = new Request(request.url, { method: 'POST', headers: request.headers, body, signal });
    if (path === mcpPaths.register) return finish(await authorization.fetch(sanitized, bindings, ctx));

    const form = new URLSearchParams(body);
    if ([...form.keys()].some((name) => form.getAll(name).length !== 1)) return error(400, 'invalid_request');
    if (form.has('resource') && form.get('resource') !== config.resource) return error(400, 'invalid_target');
    const exchange = await exchangeFor(form, signal);
    const provider = exchange ? createMcpAuthorizationServer(config, exchange) : authorization;
    const response = await provider.fetch(sanitized, bindings, ctx);
    const client = requestClientId(request, form);
    if (!response.ok) {
      if (exchange?.confirmedReplay && client) {
        await revokeReplayedExchange(env.DB, client, config.issuer, exchange.kind, exchange.digest);
      }
      return finish(response);
    }
    const revokedToken = form.get('token');
    if (!form.get('grant_type') && revokedToken) {
      if (!client) return error(503, 'temporarily_unavailable');
      await revokeIssuedCredential(env.DB, config.issuer, client, await credentialDigest(revokedToken));
      return finish(response);
    }
    if (!exchange?.verified) return error(400, 'invalid_grant');
    const tokens = await response.clone().json<{ access_token: string; refresh_token: string; expires_in: number }>();
    if (!(await recordTokenIssue(env.DB, exchange.verified, {
      kind: exchange.kind, access: tokens.access_token, refresh: tokens.refresh_token, accessTtl: tokens.expires_in
    }))) return error(400, 'invalid_grant');
    return finish(response);
  } catch (failure) {
    if (failure instanceof McpHttpError) return error(failure.status, failure.code);
    if (signal.aborted) return error(504, 'request_timeout');
    return error(503, 'temporarily_unavailable');
  }
}

function requestClientId(request: Request, form: URLSearchParams) {
  const encoded = /^Basic[ \t]+([^ \t]+)$/iu.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!encoded) return form.get('client_id');
  try {
    const [id] = atob(encoded).split(':', 1);
    return id ? decodeURIComponent(id.replace(/\+/gu, ' ')) : null;
  } catch {
    return null;
  }
}
