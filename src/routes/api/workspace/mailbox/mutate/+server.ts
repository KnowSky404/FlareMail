import type { RequestHandler } from './$types';
import type { MailboxMutationAction, MailboxMutationRequest } from '$lib/domain/mail';
import { ApiError, apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { mutateWorkspaceMailbox } from '$lib/server/workspace';

const actions = new Set<MailboxMutationAction>(['archive', 'unarchive', 'read', 'unread', 'star', 'unstar']);

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const payload = await readJsonBody<MailboxMutationRequest>(event, { maxBytes: 24 * 1024 });
  if (!payload || typeof payload.action !== 'string' || !actions.has(payload.action as MailboxMutationAction)) {
    throw new ApiError(400, 'INVALID_MAILBOX_ACTION', '邮件批量操作无效。');
  }
  const ids = payload.ids ?? [];
  const threadKeys = payload.threadKeys ?? [];
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string') ||
    !Array.isArray(threadKeys) || !threadKeys.every((key) => typeof key === 'string')) {
    throw new ApiError(400, 'INVALID_MAILBOX_SELECTION', '邮件选择必须是字符串数组。');
  }
  const result = await mutateWorkspaceMailbox(getRequestEnv(event)!, session, {
    action: payload.action as MailboxMutationAction,
    messageIds: ids,
    threadKeys
  });
  return apiSuccess(event, { result });
});
