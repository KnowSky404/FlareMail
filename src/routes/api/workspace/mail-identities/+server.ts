import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { listManagedMailAddresses, listManagedMailDomains } from '$lib/server/db/mail-identities';
import { createManagedMailAddress } from '$lib/server/mail-identities/routing';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  const [domains, addresses] = await Promise.all([
    listManagedMailDomains(env.DB, session.userId),
    listManagedMailAddresses(env.DB, session.userId)
  ]);
  return apiSuccess(event, {
    domains,
    addresses,
    providerConfiguration: {
      cloudflare: Boolean(env.CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN?.trim() || env.CLOUDFLARE_EMAIL_ROUTING_TOKEN?.trim()),
      resend: Boolean(env.RESEND_API_KEY?.trim())
    }
  });
});

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = requireWorkspaceSession(event);
  const input = await readJsonBody<{
    domainId?: unknown;
    address?: unknown;
    displayName?: unknown;
    signature?: unknown;
  }>(event, { maxBytes: 20 * 1024 });
  if (
    typeof input.domainId !== 'string' || typeof input.address !== 'string' ||
    (input.displayName !== undefined && typeof input.displayName !== 'string') ||
    (input.signature !== undefined && typeof input.signature !== 'string')
  ) throw new ApiError(400, 'MAIL_ADDRESS_INPUT_INVALID', '邮件地址字段无效。', undefined, undefined, false);
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂不可用。');
  const address = await createManagedMailAddress(env, session.userId, {
    domainId: input.domainId,
    address: input.address,
    ...(typeof input.displayName === 'string' ? { displayName: input.displayName } : {}),
    ...(typeof input.signature === 'string' ? { signature: input.signature } : {})
  });
  return apiSuccess(event, { address }, { status: 201 });
});
