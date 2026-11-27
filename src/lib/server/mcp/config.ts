import type { CloudflareEnv } from '$lib/server/cloudflare';
import { parseAppEnv, parseTrustedAppBaseUrl, validateEnvironment } from '$lib/server/config/env';

export const mcpPaths = {
  resource: '/mcp',
  protectedResource: '/.well-known/oauth-protected-resource/mcp',
  protectedResourceRoot: '/.well-known/oauth-protected-resource',
  issuerMetadata: '/.well-known/oauth-authorization-server',
  authorize: '/mcp/authorize',
  token: '/mcp/token',
  register: '/mcp/register'
} as const;

const machinePaths = new Set<string>(Object.values(mcpPaths).filter((path) => path !== mcpPaths.authorize));

export function isMcpMachinePath(path: string) {
  return machinePaths.has(path);
}

export interface McpConfig {
  issuer: string;
  resource: string;
  allowLoopback: boolean;
  redirects: Set<string>;
}

export type McpEnv = CloudflareEnv & { OAUTH_KV: KVNamespace };

export function mcpConfig(env: CloudflareEnv): McpConfig | null {
  try {
    const runtime = validateEnvironment(env as unknown as Record<string, unknown>);
    if (!runtime.ok || !env.DB || !env.BUCKET || !env.OAUTH_KV || !env.MCP_PUBLIC_URL) return null;
    const appEnv = parseAppEnv(env.APP_ENV);
    const url = new URL(env.MCP_PUBLIC_URL);
    const allowLoopback = appEnv === 'development' || appEnv === 'test';
    const issuer = parseTrustedAppBaseUrl(url.origin, appEnv);
    if (!issuer || env.MCP_PUBLIC_URL !== issuer + mcpPaths.resource ||
        issuer !== runtime.config.appBaseUrl) return null;
    const redirects = new Set([
      'https://chatgpt.com/connector_platform_oauth_redirect',
      ...(env.MCP_ALLOWED_REDIRECT_URIS?.split(',').map((uri) => uri.trim()).filter(Boolean) ?? [])
    ]);
    if ([...redirects].some((uri) => !isSafeRedirect(uri, allowLoopback))) return null;
    return { issuer, resource: url.href, allowLoopback, redirects };
  } catch {
    return null;
  }
}

function isSafeRedirect(uri: string, allowLoopback: boolean) {
  try {
    const url = new URL(uri);
    return uri.length <= 512 && !url.username && !url.password && !url.hash &&
      (url.protocol === 'https:' || (allowLoopback && url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch {
    return false;
  }
}

export function isAllowedRedirect(uri: string, config: McpConfig) {
  return config.redirects.has(uri) && isSafeRedirect(uri, config.allowLoopback);
}

export function isMcpOwnerConfiguration(env: CloudflareEnv, owner: string) {
  return env.AUTH_MODE?.trim().toLowerCase() !== 'cloudflare-access' || env.ACCESS_OWNER_USER_ID?.trim() === owner;
}
