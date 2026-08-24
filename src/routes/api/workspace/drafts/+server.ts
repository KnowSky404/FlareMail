import type { RequestHandler } from './$types';
import type { ComposeInput } from '$lib/domain/mail';
import { ApiError, apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { saveWorkspaceDraft } from '$lib/server/workspace';
import { fieldErrorsFromIssues } from '$lib/server/http/api';
import { MAIL_LIMITS, validateDraftInput } from '$lib/domain/mail';
import { DraftBodyReloadRequiredError, DraftConflictError, DraftNotFoundError } from '$lib/server/workspace/draft';
import { SafeHtmlError } from '$lib/server/mail/html-sanitize';

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const payload = await readJsonBody<ComposeInput>(event, { maxBytes: MAIL_LIMITS.body * 2 + 512 * 1024 });
  const validation = validateDraftInput(payload);
  if (!validation.ok) {
    throw new ApiError(400, 'VALIDATION_FAILED', '草稿内容未通过验证。', fieldErrorsFromIssues(validation.issues));
  }
  try {
    return apiSuccess(event, await saveWorkspaceDraft(getRequestEnv(event), session, validation.value));
  } catch (error) {
    if (error instanceof SafeHtmlError) {
      throw new ApiError(400, 'VALIDATION_FAILED', error.message, fieldErrorsFromIssues([{ field: 'html', message: error.message }]));
    }
    if (error instanceof DraftConflictError) {
      throw new ApiError(409, 'DRAFT_CONFLICT', '服务器版本已更新。', undefined, {
        draftId: error.current.id,
        updatedAt: error.current.sentAt
      });
    }
    if (error instanceof DraftBodyReloadRequiredError) {
      throw new ApiError(409, error.code, error.message);
    }
    if (error instanceof DraftNotFoundError) throw new ApiError(404, 'DRAFT_NOT_FOUND', error.message);
    throw error;
  }
});
