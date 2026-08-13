import type { CloudflareEnv } from '$lib/server/cloudflare';
import type { WorkspaceCapabilities } from '$lib/server/workspace/shared';

export async function hasNamedTables(db: D1Database, names: string[]): Promise<boolean> {
  const placeholders = names.map(() => '?').join(', ');
  const row = await db.prepare(`
    SELECT COUNT(*) AS total FROM sqlite_master
    WHERE type = 'table' AND name IN (${placeholders})
  `).bind(...names).first<{ total: number }>();
  return (row?.total ?? 0) === names.length;
}

export async function hasWorkspaceCoreTables(env?: CloudflareEnv): Promise<boolean> {
  if (!env?.DB) return false;
  try { return await hasNamedTables(env.DB, ['workspace_users', 'workspace_sessions', 'workspace_messages']); }
  catch { return false; }
}

const emptyCapabilities = (): WorkspaceCapabilities => ({
  drafts: false, inboundStates: false, outboundStatuses: false, outboundReceipts: false, outboundEvents: false
});

export async function getWorkspaceCapabilities(env?: CloudflareEnv): Promise<WorkspaceCapabilities> {
  if (!env?.DB) return emptyCapabilities();
  try {
    const [drafts, inboundStates, outboundStatuses, outboundReceipts, outboundEvents] = await Promise.all([
      hasNamedTables(env.DB, ['workspace_drafts']), hasNamedTables(env.DB, ['workspace_email_states']),
      hasNamedTables(env.DB, ['workspace_outbound_statuses']), hasNamedTables(env.DB, ['workspace_outbound_receipts']),
      hasNamedTables(env.DB, ['workspace_outbound_events'])
    ]);
    return { drafts, inboundStates, outboundStatuses, outboundReceipts, outboundEvents };
  } catch { return emptyCapabilities(); }
}
