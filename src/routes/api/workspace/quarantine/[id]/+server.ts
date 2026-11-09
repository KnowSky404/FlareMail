import type { RequestHandler } from './$types';
import { releaseQuarantinedMail } from '$lib/server/db/blocked-senders';
import { apiSuccess, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  await releaseQuarantinedMail(getRequestEnv(event)!.DB, session.userId, event.params.id!);
  return apiSuccess(event, { released: true });
});
