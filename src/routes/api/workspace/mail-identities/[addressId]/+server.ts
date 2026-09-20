import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import {
  deleteManagedMailAddress,
  disableManagedMailAddress,
  enableManagedMailAddress,
  importExistingWorkerRule,
  restoreManagedMailAddress,
  retryManagedMailAddress
} from '$lib/server/mail-identities/routing';
import { updateManagedMailAddressSending, type MailAddressSendingAction } from '$lib/server/mail-identities/sending';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';

type AddressAction = 'disable' | 'enable' | 'import' | 'restore' | 'retry' | MailAddressSendingAction;

function addressIdFromRoute(value: string | undefined) {
  if (!value || !/^[A-Fa-f0-9-]{36}$/u.test(value)) {
    throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
  }
  return value;
}

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = requireWorkspaceSession(event);
  const addressId = addressIdFromRoute(event.params.addressId);
  const input = await readJsonBody<{ action?: unknown }>(event, { maxBytes: 1024 });
  if (typeof input.action !== 'string' || !['disable', 'enable', 'import', 'restore', 'retry', 'enable_send', 'disable_send', 'make_default'].includes(input.action)) {
    throw new ApiError(400, 'MAIL_ADDRESS_ACTION_INVALID', '邮件地址操作无效。', undefined, undefined, false);
  }
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂不可用。');
  const action = input.action as AddressAction;
  const address = action === 'disable'
    ? await disableManagedMailAddress(env, session.userId, addressId)
    : action === 'enable'
      ? await enableManagedMailAddress(env, session.userId, addressId)
      : action === 'import'
          ? await importExistingWorkerRule(env, session.userId, addressId)
          : action === 'restore'
            ? await restoreManagedMailAddress(env, session.userId, addressId)
            : action === 'retry'
              ? await retryManagedMailAddress(env, session.userId, addressId)
              : await updateManagedMailAddressSending(env, session.userId, addressId, action);
  return apiSuccess(event, { address });
});

export const DELETE: RequestHandler = withApiHandler(async (event) => {
  const session = requireWorkspaceSession(event);
  const addressId = addressIdFromRoute(event.params.addressId);
  const input = await readJsonBody<{ confirm?: unknown }>(event, { maxBytes: 1024 });
  if (typeof input.confirm !== 'string' || input.confirm.trim().toLowerCase() !== 'delete') {
    throw new ApiError(400, 'MAIL_ADDRESS_DELETE_CONFIRMATION_REQUIRED', '删除邮件地址需要显式确认。', undefined, undefined, false);
  }
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂不可用。');
  const result = await deleteManagedMailAddress(env, session.userId, addressId);
  return apiSuccess(event, result);
});
