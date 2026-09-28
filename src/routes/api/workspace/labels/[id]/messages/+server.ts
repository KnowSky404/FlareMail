import type { RequestHandler } from './$types';
import type { RequestEvent } from '@sveltejs/kit';
import type { LabelTarget } from '$lib/server/db/labels';
import { ApiError, apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { setMailMessageLabel, setManyMailMessageLabels } from '$lib/server/db/labels';

async function change(event: RequestEvent, enabled: boolean) {
  const session = await requireWorkspaceMailboxSession(event);
  const target = await readJsonBody<LabelTarget>(event, { maxBytes: 2048 });
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new ApiError(400, 'INVALID_LABEL_TARGET', '邮件标识无效。');
  }
  const labels = await setMailMessageLabel(getRequestEnv(event)!.DB, session.userId, event.params.id!, target, enabled);
  return apiSuccess(event, { labels });
}

export const PUT: RequestHandler = withApiHandler((event) => change(event, true));
export const DELETE: RequestHandler = withApiHandler((event) => change(event, false));

export const PATCH: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const payload = await readJsonBody<{ targets?: unknown; enabled?: unknown }>(event, { maxBytes: 48 * 1024 });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.enabled !== 'boolean') {
    throw new ApiError(400, 'INVALID_LABEL_TARGETS', '请选择有效的批量标签操作。');
  }
  const processed = await setManyMailMessageLabels(
    getRequestEnv(event)!.DB, session.userId, event.params.id!, payload.targets, payload.enabled
  );
  return apiSuccess(event, { processed });
});
