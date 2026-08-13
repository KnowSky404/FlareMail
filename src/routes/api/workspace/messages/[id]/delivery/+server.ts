import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, requirePathParam, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { getWorkspaceMessageDeliveryDetail } from '$lib/server/workspace';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const detail = await getWorkspaceMessageDeliveryDetail(getRequestEnv(event), session, requirePathParam(event, 'id'));
  if (!detail) throw new ApiError(404, 'DELIVERY_DETAIL_NOT_FOUND', '当前邮件没有可用的投递回执。');
  return apiSuccess(event, { detail });
});
