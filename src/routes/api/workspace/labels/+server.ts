import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { createMailLabel, listMailLabels } from '$lib/server/db/labels';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  return apiSuccess(event, { labels: await listMailLabels(getRequestEnv(event)!.DB, session.userId) });
});

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const payload = await readJsonBody<{ name?: unknown }>(event, { maxBytes: 2048 });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ApiError(400, 'INVALID_LABEL_NAME', '请输入标签名称。');
  }
  const label = await createMailLabel(getRequestEnv(event)!.DB, session.userId, payload.name);
  return apiSuccess(event, { label }, { status: 201 });
});
