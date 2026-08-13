import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, requirePathParam, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { deleteWorkspaceMessage } from '$lib/server/workspace';

export const DELETE: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const result = await deleteWorkspaceMessage(getRequestEnv(event), session, requirePathParam(event, 'id'));
  if (!result) throw new ApiError(404, 'MESSAGE_NOT_FOUND', '邮件不存在。');
  return apiSuccess(event, result);
});
