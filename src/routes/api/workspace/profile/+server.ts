import type { RequestHandler } from './$types';
import { validateProfile, type UserProfile } from '$lib/domain/mail';
import {
  ApiError,
  apiSuccess,
  fieldErrorsFromIssues,
  readJsonBody,
  withApiHandler
} from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';
import { loadWorkspaceSnapshot, updateWorkspaceProfile } from '$lib/server/workspace';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'WORKSPACE_UNAVAILABLE', '工作区存储暂不可用。');
  const { workspace } = await loadWorkspaceSnapshot(env, session);
  return apiSuccess(event, { profile: session.profile, workspace });
});

export const PUT: RequestHandler = withApiHandler(async (event) => {
  const session = requireWorkspaceSession(event);
  const validation = validateProfile(await readJsonBody<UserProfile>(event, { maxBytes: 32 * 1024 }));
  if (!validation.ok) {
    throw new ApiError(400, 'VALIDATION_FAILED', '个人资料未通过验证。', fieldErrorsFromIssues(validation.issues));
  }
  return apiSuccess(event, {
    workspace: await updateWorkspaceProfile(getRequestEnv(event), session, validation.value)
  });
});
