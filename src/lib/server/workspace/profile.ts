import type { CloudflareEnv } from '$lib/server/cloudflare';
import { hasWorkspaceCoreTables } from '$lib/server/db/capabilities';
import { updateUserProfile } from '$lib/server/db/users';
import { refreshD1Session } from '$lib/server/workspace/mailbox';
import { normalizeProfile, serializeWorkspace, type UserProfile, type WorkspaceSession } from '$lib/server/workspace/shared';

export async function updateWorkspaceProfile(env: CloudflareEnv | undefined, session: WorkspaceSession, nextProfile: UserProfile) {
  const profile = normalizeProfile(nextProfile);
  if (session.storage === 'd1' && await hasWorkspaceCoreTables(env)) {
    await updateUserProfile(env!.DB, session.userId, profile);
    const nextSession = await refreshD1Session(env, session.id);
    if (!nextSession) throw new Error('保存资料后无法重新加载工作区。');
    return serializeWorkspace(nextSession);
  }
  throw new Error('工作区存储未配置，无法保存资料。');
}
