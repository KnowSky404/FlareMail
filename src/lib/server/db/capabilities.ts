import type { CloudflareEnv } from '$lib/server/cloudflare';
import type { WorkspaceCapabilities } from '$lib/server/workspace/shared';
import { FLAREMAIL_SCHEMA_VERSION } from '$lib/server/db/schema-version';

async function isCurrentSchema(env?: CloudflareEnv): Promise<boolean> {
  if (!env?.DB) return false;
  try {
    const row = await env.DB.prepare(
      'SELECT schema_version FROM workspace_schema_metadata WHERE schema_name = ?'
    ).bind('flaremail').first<{ schema_version: number }>();
    return row?.schema_version === FLAREMAIL_SCHEMA_VERSION;
  } catch {
    return false;
  }
}

export async function hasWorkspaceCoreTables(env?: CloudflareEnv): Promise<boolean> {
  return isCurrentSchema(env);
}

const emptyCapabilities = (): WorkspaceCapabilities => ({
  drafts: false, inboundStates: false, outboundStatuses: false, outboundReceipts: false, outboundEvents: false, recipientArrays: false
});

export async function getWorkspaceCapabilities(env?: CloudflareEnv): Promise<WorkspaceCapabilities> {
  return await isCurrentSchema(env)
    ? { drafts: true, inboundStates: true, outboundStatuses: true, outboundReceipts: true, outboundEvents: true, recipientArrays: true }
    : emptyCapabilities();
}
