import type { RequestEvent } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { mcpScopeMask, mcpScopes, scopesFromMask } from '$lib/domain/mail/mcp';
import { apiSuccess, ApiError, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { isMcpOwnerConfiguration, mcpConfig } from '$lib/server/mcp/config';
import { listMcpActivity, listMcpGrants, ownerPolicy, revokeMcpGrants, updateMcpPolicy } from '$lib/server/mcp/store';

async function owner(event: RequestEvent) {
  const session = await requireWorkspaceMailboxSession(event);
  const env = getRequestEnv(event)!;
  const policy = await ownerPolicy(env.DB, session.userId);
  if (!policy || !isMcpOwnerConfiguration(env, session.userId)) throw new ApiError(403, 'MCP_OWNER_REQUIRED', '仅 Owner 可管理集成。');
  return { env, policy, id: session.userId, config: mcpConfig(env) };
}

const mutations = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('settings'), enabled: z.boolean(), scopes: z.array(z.enum(mcpScopes)).max(mcpScopes.length) }),
  z.strictObject({ action: z.literal('revoke'), id: z.uuid() }),
  z.strictObject({ action: z.literal('revoke-all') })
]);

export const GET: RequestHandler = withApiHandler(async (event) => {
  const { env, policy, id, config } = await owner(event);
  const time = event.url.searchParams.get('time');
  const cursorId = event.url.searchParams.get('id');
  const cursor = time !== null || cursorId !== null ? z.object({
    time: z.coerce.number().int().positive(), id: z.uuid()
  }).safeParse({ time, id: cursorId }) : null;
  if (cursor && !cursor.success) throw new ApiError(400, 'INVALID_CURSOR', '无效的活动分页游标。');
  let available = false;
  if (config && env.OAUTH_KV) {
    try {
      await env.OAUTH_KV.get('flaremail:health');
      available = true;
    } catch { /* Expose a generic storage state. */ }
  }
  const [clients, activity] = await Promise.all([
    listMcpGrants(env.DB, id),
    listMcpActivity(env.DB, id, cursor?.data ?? null)
  ]);
  return apiSuccess(event, {
    status: !config ? 'incomplete' : !available ? 'unavailable' : policy.enabled ? 'enabled' : 'disabled',
    enabled: Boolean(policy.enabled), endpoint: config?.resource ?? null, scopes: scopesFromMask(policy.scopes),
    clients, activeCount: clients.filter((client) => client.status === 'active').length, activity
  });
});

export const POST: RequestHandler = withApiHandler(async (event) => {
  const { env, id, config } = await owner(event);
  const parsed = mutations.safeParse(await readJsonBody(event, { maxBytes: 1024 }));
  if (!parsed.success) throw new ApiError(400, 'INVALID_MCP_SETTINGS', '无效的集成操作。');
  const input = parsed.data;
  if (input.action === 'settings') {
    if (input.enabled) {
      if (!config || !env.OAUTH_KV) throw new ApiError(409, 'MCP_CONFIGURATION_INCOMPLETE', 'MCP 配置尚未完成。');
      try { await env.OAUTH_KV.get('flaremail:health'); }
      catch { throw new ApiError(503, 'MCP_UNAVAILABLE', 'MCP 暂不可用。'); }
    }
    if (!(await updateMcpPolicy(env.DB, id, input.enabled, mcpScopeMask(input.scopes)))) {
      throw new ApiError(403, 'MCP_OWNER_REQUIRED', '仅 Owner 可管理集成。');
    }
  } else {
    await revokeMcpGrants(env.DB, id, input.action === 'revoke' ? input.id : undefined);
  }
  return apiSuccess(event, { saved: true });
});
