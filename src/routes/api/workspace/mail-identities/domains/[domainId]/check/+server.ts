import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, withApiHandler } from '$lib/server/http/api';
import { checkManagedMailDomain } from '$lib/server/mail-identities/check';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = requireWorkspaceSession(event);
  const domainId = event.params.domainId;
  if (!domainId || !/^[A-Fa-f0-9-]{36}$/u.test(domainId)) {
    throw new ApiError(404, 'MAIL_DOMAIN_NOT_FOUND', '邮件域名不存在。', undefined, undefined, false);
  }
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂不可用。');
  return apiSuccess(event, { check: await checkManagedMailDomain(env, session.userId, domainId) });
});
