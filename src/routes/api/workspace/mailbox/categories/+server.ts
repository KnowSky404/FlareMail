import type { RequestHandler } from './$types';
import type { MailboxCategoryMutationRequest } from '$lib/domain/mail';
import { ApiError, apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { changeMailboxCategories } from '$lib/server/workspace/categories';

export const PATCH: RequestHandler = withApiHandler(async (event) => {
  const workspace = await requireWorkspaceMailboxSession(event);
  const payload = await readJsonBody<MailboxCategoryMutationRequest>(event, { maxBytes: 32 * 1024 });
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'WORKSPACE_UNAVAILABLE', '工作区存储暂不可用。');
  return apiSuccess(event, await changeMailboxCategories(env, workspace, payload));
});
