import type { RequestHandler } from './$types';
import type { ComposeInput } from '$lib/domain/mail';
import { ApiError, apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { saveWorkspaceDraft } from '$lib/server/workspace';
import { MAIL_LIMITS } from '$lib/domain/mail';
import { DraftConflictError, DraftNotFoundError } from '$lib/server/workspace/draft';

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const payload = await readJsonBody<ComposeInput>(event, { maxBytes: MAIL_LIMITS.body * 4 + 32 * 1024 });
  try {
    return apiSuccess(event, await saveWorkspaceDraft(getRequestEnv(event), session, payload));
  } catch (error) {
    if (error instanceof DraftConflictError) {
      throw new ApiError(409, 'DRAFT_CONFLICT', '服务器版本已更新。', undefined, { draft: error.current });
    }
    if (error instanceof DraftNotFoundError) throw new ApiError(404, 'DRAFT_NOT_FOUND', error.message);
    throw error;
  }
});
