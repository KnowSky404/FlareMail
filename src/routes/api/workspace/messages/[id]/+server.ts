import type { RequestHandler } from './$types';
import { getMailboxMetrics } from '$lib/server/db/mailbox';
import { findOwnedInboundState } from '$lib/server/db/inbound';
import { fromInboundMessageId, isInboundMessageId, mapInboundRow } from '$lib/server/workspace/shared';
import { ApiError, apiSuccess, requirePathParam, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { deleteWorkspaceMessage } from '$lib/server/workspace';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const routeMessageId = requirePathParam(event, 'id');
  if (!isInboundMessageId(routeMessageId)) throw new ApiError(404, 'MESSAGE_NOT_FOUND', '邮件不存在。');
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'WORKSPACE_UNAVAILABLE', '工作区存储暂不可用。');
  const row = await findOwnedInboundState(env.DB, session.userId, fromInboundMessageId(routeMessageId), { includeBody: false });
  if (!row) throw new ApiError(404, 'MESSAGE_NOT_FOUND', '邮件不存在。');
  return apiSuccess(event, {
    message: { ...mapInboundRow(row, session.profile), body: '' },
    metrics: await getMailboxMetrics(env.DB, session.userId)
  });
});

export const DELETE: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const result = await deleteWorkspaceMessage(getRequestEnv(event), session, requirePathParam(event, 'id'));
  if (!result) throw new ApiError(404, 'MESSAGE_NOT_FOUND', '邮件不存在。');
  return apiSuccess(event, result);
});
