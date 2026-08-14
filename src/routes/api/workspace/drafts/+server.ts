import type { RequestHandler } from './$types';
import type { ComposeInput } from '$lib/domain/mail';
import { apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { saveWorkspaceDraft } from '$lib/server/workspace';
import { MAIL_LIMITS } from '$lib/domain/mail';

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const payload = await readJsonBody<ComposeInput>(event, { maxBytes: MAIL_LIMITS.body * 4 + 32 * 1024 });
  return apiSuccess(event, await saveWorkspaceDraft(getRequestEnv(event), session, payload));
});
