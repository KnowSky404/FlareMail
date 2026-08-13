import type { CloudflareEnv } from '$lib/server/cloudflare';
import { hasWorkspaceCoreTables } from '$lib/server/db/capabilities';
import { updateUserProfile } from '$lib/server/db/users';
import { loadWorkspaceSnapshot } from '$lib/server/workspace/mailbox';
import { normalizeProfile, type UserProfile, type WorkspaceContext } from '$lib/server/workspace/shared';

export async function updateWorkspaceProfile(env: CloudflareEnv | undefined, session: WorkspaceContext, nextProfile: UserProfile) {
  const profile = normalizeProfile(nextProfile);
  if (session.storage === 'd1' && await hasWorkspaceCoreTables(env)) {
    await updateUserProfile(env!.DB, session.userId, profile);
    return (await loadWorkspaceSnapshot(env!, { ...session, profile })).workspace;
  }
  throw new Error('工作区存储未配置，无法保存资料。');
}
