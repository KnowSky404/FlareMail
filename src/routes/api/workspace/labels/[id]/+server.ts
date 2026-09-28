import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { deleteMailLabel, renameMailLabel } from '$lib/server/db/labels';

export const PATCH: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const payload = await readJsonBody<{ name?: unknown }>(event, { maxBytes: 2048 });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ApiError(400, 'INVALID_LABEL_NAME', '请输入标签名称。');
  }
  const label = await renameMailLabel(getRequestEnv(event)!.DB, session.userId, event.params.id!, payload.name);
  return apiSuccess(event, { label });
});

export const DELETE: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  await deleteMailLabel(getRequestEnv(event)!.DB, session.userId, event.params.id!);
  return apiSuccess(event, { deleted: true });
});
