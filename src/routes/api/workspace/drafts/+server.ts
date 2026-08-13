import type { RequestHandler } from './$types';
import type { ComposeInput } from '$lib/domain/mail';
import { apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { saveWorkspaceDraft } from '$lib/server/workspace';

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const payload = await readJsonBody<ComposeInput>(event);
  return apiSuccess(event, await saveWorkspaceDraft(getRequestEnv(event), session, payload));
});
