export const mcpScopes = ['mail.read', 'mail.metadata.read', 'mail.attachments.metadata.read'] as const;
export type McpScope = (typeof mcpScopes)[number];
export const defaultMcpScopes = 3;

export function mcpScopeMask(scopes: readonly string[]): number {
  return mcpScopes.reduce((mask, scope, index) => scopes.includes(scope) ? mask | (1 << index) : mask, 0);
}

export function scopesFromMask(mask: number): McpScope[] {
  return mcpScopes.filter((_, index) => mask & (1 << index));
}
