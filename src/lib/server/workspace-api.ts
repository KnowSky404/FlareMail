import type { RequestEvent } from '@sveltejs/kit';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { ApiError } from '$lib/server/http/api';

export type {
  WorkspaceSnapshotOptions
} from '$lib/server/workspace/mailbox';
export type { WorkspaceSnapshot } from '$lib/domain/mail';

export function getRequestEnv(event: RequestEvent) {
  return event.platform?.env as CloudflareEnv | undefined;
}

export function requireWorkspaceSession(event: RequestEvent) {
  const session = event.locals.workspaceSession;

  if (!session) {
    throw new ApiError(401, 'AUTHENTICATION_REQUIRED', '请先登录工作台。');
  }

  return session;
}

export async function requireWorkspaceMailboxSession(event: RequestEvent) {
  const context = requireWorkspaceSession(event);
  if (context.storage !== 'd1' || !getRequestEnv(event)?.DB) throw new ApiError(503, 'WORKSPACE_UNAVAILABLE', '工作区存储暂不可用。');
  return context;
}
