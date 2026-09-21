import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, withApiHandler } from '$lib/server/http/api';
import { previewManagedMailAddressDeletion } from '$lib/server/mail-identities/routing';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = requireWorkspaceSession(event);
  const addressId = event.params.addressId;
  if (!addressId || !/^[A-Fa-f0-9-]{36}$/u.test(addressId)) {
    throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
  }
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂不可用。');
  const preview = await previewManagedMailAddressDeletion(env, session.userId, addressId);
  return apiSuccess(event, { preview });
});
