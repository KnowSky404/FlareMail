import type { RequestHandler } from './$types';
import { apiSuccess, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';
import { loadMailboxPage } from '$lib/server/workspace';
import { parseMailboxQuery } from '$lib/server/workspace/mailbox-query';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const workspace = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  if (!env?.DB) throw new Error('D1 binding is unavailable.');
  const page = await loadMailboxPage(env, workspace, parseMailboxQuery(event.url.searchParams));
  return apiSuccess(event, { page });
});
