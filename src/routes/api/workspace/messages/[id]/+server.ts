import type { RequestHandler } from './$types';
import { getMailboxMetrics } from '$lib/server/db/mailbox';
import { readWorkspaceMessage } from '$lib/server/workspace/reader';
import { ApiError, apiSuccess, requirePathParam, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { deleteWorkspaceMessage } from '$lib/server/workspace';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const routeMessageId = requirePathParam(event, 'id');
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'WORKSPACE_UNAVAILABLE', '工作区存储暂不可用。');
  const message = await readWorkspaceMessage(env, session, routeMessageId);
  if (!message) throw new ApiError(404, 'MESSAGE_NOT_FOUND', '邮件不存在。');
  return apiSuccess(event, {
    message,
    metrics: await getMailboxMetrics(env.DB, session.userId),
    metricsScope: { identityFilter: null }
  });
});

export const DELETE: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const result = await deleteWorkspaceMessage(getRequestEnv(event), session, requirePathParam(event, 'id'));
  if (!result) throw new ApiError(404, 'MESSAGE_NOT_FOUND', '邮件不存在。');
  return apiSuccess(event, result);
});
