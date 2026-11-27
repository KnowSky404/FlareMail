import {
  GrantType, OAuthAuthorizationServer, OAuthError, type TokenExchangeCallbackOptions
} from '@cloudflare/workers-oauth-provider';
import { mcpScopes, mcpScopeMask, scopesFromMask } from '$lib/domain/mail/mcp';
import { isAllowedRedirect, isMcpOwnerConfiguration, mcpPaths, type McpConfig, type McpEnv } from './config';
import {
  accessLifetime, consumeExchange, credentialDigest, grantLifetime, type GrantKey
} from './store';

export interface GrantProps {
  id: string;
  issuer: string;
}

export function isGrantProps(value: unknown): value is GrantProps {
  if (!value || typeof value !== 'object') return false;
  const props = value as Partial<GrantProps>;
  return typeof props.id === 'string' && /^[a-f0-9-]{36}$/u.test(props.id) && typeof props.issuer === 'string';
}

interface Exchange {
  kind: 'code' | 'refresh';
  digest: string;
  redirect?: string;
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
          !isMcpOwnerConfiguration(env, userId) ||
          (grantType === GrantType.AUTHORIZATION_CODE && (exchange.kind !== 'code' || !exchange.redirect)) ||
          (grantType === GrantType.REFRESH_TOKEN && exchange.kind !== 'refresh')) {
        throw new OAuthError('invalid_grant', { description: 'The authorization is no longer valid.' });
      }
      const grant: GrantKey = { id: props.id, issuer: config.issuer, owner: userId, client: clientId };
      const allowed = await consumeExchange(env.DB, grant, exchange.kind, exchange.digest);
      if (!allowed) throw new OAuthError('invalid_grant', { description: 'The authorization is no longer valid.' });
      const scope = mcpScopeMask(requestedScope) & allowed;
      if (!scope) throw new OAuthError('invalid_grant', { description: 'The requested permissions are no longer granted.' });
      exchange.verified = grant;
      return { accessTokenScope: scopesFromMask(scope) };
    }
  });
}

export async function exchangeFor(form: URLSearchParams): Promise<Exchange | undefined> {
  const grantType = form.get('grant_type');
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') return;
  const kind = grantType === 'authorization_code' ? 'code' : 'refresh';
  const value = form.get(kind === 'code' ? 'code' : 'refresh_token');
  if (!value || value.length > 512) return;
  return { kind, digest: await credentialDigest(value), redirect: form.get('redirect_uri') ?? undefined };
}

export { AuthorizationError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
