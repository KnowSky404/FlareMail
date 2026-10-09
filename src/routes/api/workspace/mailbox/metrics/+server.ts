import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { getMailboxMetrics } from '$lib/server/db/mailbox';
import { mailboxIdentityFilterExists } from '$lib/server/db/mail-identities';
import { parseIdentityFilter } from '$lib/server/workspace/mailbox-query';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const env = getRequestEnv(event)!;
  const identityFilter = parseIdentityFilter(event.url.searchParams.get('identity'));
  if (identityFilter && !(await mailboxIdentityFilterExists(env.DB, session.userId, identityFilter))) {
    throw new ApiError(404, 'MAIL_IDENTITY_NOT_FOUND', '所选邮件身份不存在或不属于当前工作区。');
  }
  return apiSuccess(event, {
    metrics: await getMailboxMetrics(env.DB, session.userId, identityFilter),
    metricsScope: { identityFilter }
  });
});
