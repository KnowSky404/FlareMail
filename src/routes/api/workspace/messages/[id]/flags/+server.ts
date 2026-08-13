import type { RequestHandler } from './$types';
import type { MessagePatch } from '$lib/domain/mail';
import { ApiError, apiSuccess, readJsonBody, requirePathParam, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { patchWorkspaceMessage } from '$lib/server/workspace';

export const PATCH: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const payload = await readJsonBody<MessagePatch>(event);
  if (
    !payload ||
    (payload.read === undefined && payload.starred === undefined) ||
    (payload.read !== undefined && typeof payload.read !== 'boolean') ||
    (payload.starred !== undefined && typeof payload.starred !== 'boolean')
  ) throw new ApiError(400, 'INVALID_MESSAGE_PATCH', '邮件状态更新内容无效。');
  const result = await patchWorkspaceMessage(getRequestEnv(event), session, requirePathParam(event, 'id'), payload);
  if (!result) throw new ApiError(404, 'MESSAGE_NOT_FOUND', '邮件不存在。');
  return apiSuccess(event, result);
});
