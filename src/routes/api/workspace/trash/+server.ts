import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { emptyWorkspaceTrash, listWorkspaceTrash } from '$lib/server/workspace/trash';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const limit = Number(event.url.searchParams.get('limit') ?? '100');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new ApiError(400, 'INVALID_LIMIT', '回收站分页参数无效。', undefined, undefined, false);
  return apiSuccess(event, await listWorkspaceTrash(getRequestEnv(event), session, limit));
});

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const body = await readJsonBody<{ action?: string }>(event, { maxBytes: 8 * 1024 });
  if (body.action !== 'empty') throw new ApiError(400, 'INVALID_TRASH_ACTION', '回收站操作无效。', undefined, undefined, false);
  return apiSuccess(event, await emptyWorkspaceTrash(getRequestEnv(event), session));
});
