import type { CloudflareEnv } from '$lib/server/cloudflare';
import type { WorkspaceCapabilities } from '$lib/server/workspace/shared';

export async function hasWorkspaceCoreTables(env?: CloudflareEnv): Promise<boolean> {
  return Boolean(env?.DB);
}

const emptyCapabilities = (): WorkspaceCapabilities => ({
  drafts: false, inboundStates: false, outboundStatuses: false, outboundReceipts: false, outboundEvents: false
});

export async function getWorkspaceCapabilities(env?: CloudflareEnv): Promise<WorkspaceCapabilities> {
  return env?.DB ? { drafts: true, inboundStates: true, outboundStatuses: true, outboundReceipts: true, outboundEvents: true } : emptyCapabilities();
}
