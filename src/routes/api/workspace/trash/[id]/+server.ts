import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, requirePathParam, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { permanentlyDeleteWorkspaceTrash, restoreWorkspaceTrash } from '$lib/server/workspace/trash';

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const id = requirePathParam(event, 'id');
  const result = await restoreWorkspaceTrash(getRequestEnv(event), session, id);
  if (!result) throw new ApiError(404, 'TRASH_ITEM_NOT_FOUND', '回收站项目不存在或不属于当前账号。');
  return apiSuccess(event, result);
});

export const DELETE: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const id = requirePathParam(event, 'id');
  return apiSuccess(event, await permanentlyDeleteWorkspaceTrash(getRequestEnv(event), session, id));
});
