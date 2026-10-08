import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { updateMailDomain } from '$lib/server/mail-identities/domains';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';

export const PATCH: RequestHandler = withApiHandler(async (event) => {
  const session = requireWorkspaceSession(event);
  const input = await readJsonBody<Record<string, unknown> | null>(event, { maxBytes: 1024 });
  if (!input || !Object.keys(input).length || Object.keys(input).some((key) => !['enabled', 'unknownRecipientPolicy'].includes(key)) ||
    (input.enabled !== undefined && typeof input.enabled !== 'boolean') ||
    (input.unknownRecipientPolicy !== undefined && input.unknownRecipientPolicy !== 'reject' && input.unknownRecipientPolicy !== 'collect')) {
    throw new ApiError(400, 'MAIL_DOMAIN_INPUT_INVALID', '域名设置字段无效。', undefined, undefined, false);
  }
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂不可用。');
  const domain = await updateMailDomain(env, session.userId, event.params.domainId ?? '', {
    enabled: input.enabled,
    unknownRecipientPolicy: input.unknownRecipientPolicy
  });
  return apiSuccess(event, { domain });
});
