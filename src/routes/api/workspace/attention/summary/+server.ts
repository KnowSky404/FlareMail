import { getDeliveryAttentionSummary } from '$lib/server/db/delivery-attention';
import { apiSuccess, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const { userId } = await requireWorkspaceMailboxSession(event);
  return apiSuccess(event, await getDeliveryAttentionSummary(getRequestEnv(event)!.DB, userId));
});
