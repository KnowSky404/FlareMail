import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';
import { syncCloudflareMailIdentities } from '$lib/server/mail-identities/sync';

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂不可用。');
  return apiSuccess(event, { sync: await syncCloudflareMailIdentities(env, session.userId) });
});
