import type { RequestHandler } from './$types';
import { listQuarantinedMail } from '$lib/server/db/blocked-senders';
import { apiSuccess, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  return apiSuccess(event, await listQuarantinedMail(getRequestEnv(event)!.DB, session.userId, event.url.searchParams.get('cursor'), event.url.searchParams.get('direction') ?? 'next'));
});
