import type { RequestHandler } from './$types';
import type { DeliveryStatus, MailboxFilter, MailboxMutationAction, MailboxMutationRequest, MailboxMutationScope } from '$lib/domain/mail';
import { ApiError, apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { mutateWorkspaceMailbox } from '$lib/server/workspace';

const actions = new Set<MailboxMutationAction>(['archive', 'unarchive', 'read', 'unread', 'star', 'unstar', 'trash']);
const sections = new Set(['inbox', 'sent', 'archive']);
const threadScopes = new Set(['selected', 'filtered', 'owner']);
const filters = new Set<MailboxFilter>(['all', 'unread', 'starred']);
const deliveryStatuses = new Set<DeliveryStatus>([
  'draft', 'queued', 'submitting', 'submitted', 'sent', 'delivered', 'delayed',
  'bounced', 'failed', 'complained', 'suppressed'
]);

function parseMutationScope(value: unknown, hasThreadKeys: boolean): MailboxMutationScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'MAILBOX_SCOPE_REQUIRED', '批量操作必须声明当前邮件分区和地址筛选范围。');
  }
  const scope = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(scope, 'identityFilter') || !sections.has(String(scope.section))) {
    throw new ApiError(400, 'MAILBOX_SCOPE_REQUIRED', '批量操作必须声明当前邮件分区和地址筛选范围。');
  }
  let identityFilter: MailboxMutationScope['identityFilter'];
  if (scope.identityFilter === null) {
    identityFilter = null;
  } else if (
    typeof scope.identityFilter === 'object' && scope.identityFilter !== null && !Array.isArray(scope.identityFilter) &&
    ['domain', 'address'].includes(String((scope.identityFilter as Record<string, unknown>).kind)) &&
    typeof (scope.identityFilter as Record<string, unknown>).id === 'string' &&
    /^[A-Za-z0-9:._-]{1,128}$/u.test((scope.identityFilter as Record<string, unknown>).id as string)
  ) {
    identityFilter = {
      kind: (scope.identityFilter as { kind: 'domain' | 'address' }).kind,
      id: (scope.identityFilter as { id: string }).id
    };
  } else {
    throw new ApiError(400, 'INVALID_MAILBOX_SCOPE', '批量操作的地址筛选范围无效。');
  }

  const threadScope = scope.threadScope;
  if (!threadScopes.has(String(threadScope))) {
    throw new ApiError(400, 'MAILBOX_THREAD_SCOPE_REQUIRED', '批量操作必须明确选择已选邮件、当前筛选会话或整个 Owner 会话。');
  }
  if (threadScope === 'selected' && hasThreadKeys) {
    throw new ApiError(400, 'INVALID_MAILBOX_THREAD_SELECTION', '仅操作已选邮件时不能同时提交会话范围。');
  }
  if ((threadScope === 'filtered' || threadScope === 'owner') && !hasThreadKeys) {
    throw new ApiError(400, 'MAILBOX_THREAD_SELECTION_REQUIRED', '会话操作必须提交当前范围内已选邮件对应的会话。');
  }
  if (scope.query !== undefined && (typeof scope.query !== 'string' || scope.query.length > 200)) {
    throw new ApiError(400, 'INVALID_MAILBOX_FILTER_SCOPE', '当前筛选会话的搜索范围无效。');
  }
  if (scope.deliveryStatus !== undefined && scope.deliveryStatus !== null && !deliveryStatuses.has(scope.deliveryStatus as DeliveryStatus)) {
    throw new ApiError(400, 'INVALID_MAILBOX_FILTER_SCOPE', '当前筛选会话的投递状态无效。');
  }
  if (threadScope === 'filtered' && (
    typeof scope.query !== 'string' ||
    !filters.has(scope.filter as MailboxFilter) ||
    (scope.deliveryStatus !== undefined && scope.deliveryStatus !== null && !deliveryStatuses.has(scope.deliveryStatus as DeliveryStatus))
  )) {
    throw new ApiError(400, 'INVALID_MAILBOX_FILTER_SCOPE', '当前筛选会话的搜索或筛选范围无效。');
  }
  return {
    section: scope.section as MailboxMutationScope['section'],
    identityFilter,
    threadScope: threadScope as MailboxMutationScope['threadScope'],
    ...(threadScope === 'filtered' ? {
      query: scope.query as string,
      filter: scope.filter as MailboxFilter,
      deliveryStatus: scope.deliveryStatus as DeliveryStatus | null | undefined
    } : {})
  };
}

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
  const scope = parseMutationScope(payload.scope, threadKeys.length > 0);
  const result = await mutateWorkspaceMailbox(getRequestEnv(event)!, session, {
    action: payload.action as MailboxMutationAction,
    messageIds: ids,
    threadKeys,
    scope
  });
  return apiSuccess(event, { result });
});
