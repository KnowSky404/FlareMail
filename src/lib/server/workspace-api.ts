import { error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';

export function requireWorkspaceSession(event: RequestEvent) {
  const session = event.locals.workspaceSession;

  if (!session) {
    throw error(401, '请先登录演示工作台。');
  }

  return session;
}
