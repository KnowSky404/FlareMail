import {
  GrantType, OAuthAuthorizationServer, OAuthError, type TokenExchangeCallbackOptions
} from '@cloudflare/workers-oauth-provider';
import { mcpScopes, mcpScopeMask, scopesFromMask } from '$lib/domain/mail/mcp';
import { isAllowedRedirect, isMcpOwnerConfiguration, mcpPaths, type McpConfig, type McpEnv } from './config';
import {
  accessLifetime, consumeExchange, credentialDigest, grantLifetime, inspectExchange, revokeReplayedExchange, type GrantKey
} from './store';

export interface GrantProps {
  id: string;
  issuer: string;
  owner: string;
}

export function isGrantProps(value: unknown): value is GrantProps {
  if (!value || typeof value !== 'object') return false;
  const props = value as Partial<GrantProps>;
  return typeof props.id === 'string' && /^[a-f0-9-]{36}$/u.test(props.id) && typeof props.issuer === 'string' &&
    typeof props.owner === 'string' && props.owner.length > 0;
}

interface Exchange {
  kind: 'code' | 'refresh';
  digest: string;
  signal: AbortSignal;
  confirmedReplay?: boolean;
  verified?: GrantKey;
}

export function createMcpAuthorizationServer(config: McpConfig, exchange?: Exchange) {
  return new OAuthAuthorizationServer<McpEnv>({
    issuer: config.issuer,
    resources: [config.resource],
    defaultResource: config.resource,
    authorizeEndpoint: mcpPaths.authorize,
    tokenEndpoint: mcpPaths.token,
    clientRegistrationEndpoint: mcpPaths.register,
    scopesSupported: [...mcpScopes],
    accessTokenTTL: accessLifetime,
    refreshTokenTTL: grantLifetime,
    clientRegistrationTTL: 90 * 24 * 60 * 60,
    onError: ({ internal }) => {
      // Both SDK outcomes occur after token endpoint client authentication.
      if (exchange && ((internal.category === 'authorization-code-grant' && internal.reason === 'code_replayed') ||
          (internal.category === 'refresh-token-grant' && internal.reason === 'refresh_token_mismatch'))) {
        exchange.confirmedReplay = true;
      }
    },
    clientRegistrationCallback: ({ clientMetadata: metadata }) => {
      const redirects = metadata.redirect_uris;
      if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 4 ||
          redirects.some((uri) => typeof uri !== 'string' || !isAllowedRedirect(uri, config))) {
        return { code: 'invalid_redirect_uri', description: 'Use an allowlisted redirect URI.' };
      }
      const allowed = new Set(['client_name', 'redirect_uris', 'grant_types', 'response_types',
        'token_endpoint_auth_method', 'scope', 'client_uri', 'logo_uri', 'software_id', 'software_version']);
      if (Object.keys(metadata).some((key) => !allowed.has(key)) ||
          (metadata.client_name !== undefined && (typeof metadata.client_name !== 'string' ||
            metadata.client_name.length > 100 || /[\p{Cc}\p{Cf}]/u.test(metadata.client_name))) ||
          (metadata.grant_types !== undefined && (!Array.isArray(metadata.grant_types) ||
            !metadata.grant_types.includes('authorization_code') ||
            metadata.grant_types.some((type) => !['authorization_code', 'refresh_token'].includes(type)))) ||
          (metadata.response_types !== undefined && (!Array.isArray(metadata.response_types) ||
            metadata.response_types.length !== 1 || metadata.response_types[0] !== 'code')) ||
          (metadata.scope !== undefined && (typeof metadata.scope !== 'string' ||
            metadata.scope.split(/\s+/u).some((scope) => !mcpScopes.some((item) => item === scope))))) {
        return { code: 'invalid_client_metadata', description: 'Use supported authorization-code client metadata.' };
      }
    },
    tokenExchangeCallback: async (options: TokenExchangeCallbackOptions<McpEnv>) => {
      const { userId, clientId, props, resource, requestedScope, env, grantType } = options;
      if (!exchange || !isGrantProps(props) || props.issuer !== config.issuer || resource !== config.resource ||
          !isMcpOwnerConfiguration(env, props.owner) || userId !== await credentialDigest(props.owner) ||
          (grantType === GrantType.AUTHORIZATION_CODE && exchange.kind !== 'code') ||
          (grantType === GrantType.REFRESH_TOKEN && exchange.kind !== 'refresh')) {
        throw new OAuthError('invalid_grant', { description: 'The authorization is no longer valid.' });
      }
      const grant: GrantKey = { id: props.id, issuer: config.issuer, owner: props.owner, client: clientId };
      const requested = mcpScopeMask(requestedScope);
      const requireExchange = async () => {
        const current = await inspectExchange(env.DB, grant, exchange.kind, exchange.digest);
        if (current && current.consumed_at !== null) {
          await revokeReplayedExchange(env.DB, clientId, config.issuer, exchange.kind, exchange.digest);
          throw new OAuthError('invalid_grant', { description: 'The authorization is no longer valid.' });
        }
        if (!current) throw new OAuthError('invalid_grant', { description: 'The authorization is no longer valid.' });
        if (!(current.scopes & requested)) {
          throw new OAuthError('invalid_scope', { description: 'The requested permissions are no longer granted.' });
        }
        return current;
      };
      const current = await requireExchange();
      // The provider writes the same KV grant key at consent and on each rotation.
      const delay = current.issued_at_ms + 1250 - Date.now();
      if (delay > 0) await scheduler.wait(delay, { signal: exchange.signal });
      exchange.signal.throwIfAborted();
      const allowed = await consumeExchange(env.DB, grant, exchange.kind, exchange.digest, requested);
      if (!allowed) {
        await requireExchange();
        throw new OAuthError('temporarily_unavailable', { statusCode: 503, description: 'Retry the token request.' });
      }
      exchange.verified = grant;
      return { accessTokenScope: scopesFromMask(allowed) };
    }
  });
}

export async function exchangeFor(form: URLSearchParams, signal: AbortSignal): Promise<Exchange | undefined> {
  const grantType = form.get('grant_type');
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') return;
  const kind = grantType === 'authorization_code' ? 'code' : 'refresh';
  const value = form.get(kind === 'code' ? 'code' : 'refresh_token');
  if (!value || value.length > 512) return;
  return { kind, signal, digest: await credentialDigest(value) };
}

export { AuthorizationError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
