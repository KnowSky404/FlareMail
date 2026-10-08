import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { enrollMailDomain } from '$lib/server/mail-identities/domains';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = requireWorkspaceSession(event);
  const input = await readJsonBody<Record<string, unknown> | null>(event, { maxBytes: 1024 });
  if (!input || typeof input.domainName !== 'string' || typeof input.zoneId !== 'string' ||
    Object.keys(input).some((key) => !['domainName', 'zoneId'].includes(key))) {
    throw new ApiError(400, 'MAIL_DOMAIN_INPUT_INVALID', '域名接入字段无效。', undefined, undefined, false);
  }
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂不可用。');
  const result = await enrollMailDomain(env, session.userId, { domainName: input.domainName, zoneId: input.zoneId });
  return apiSuccess(event, result, { status: result.created ? 201 : 200 });
});
