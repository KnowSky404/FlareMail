import { deliveryAttentionKinds, type DeliveryAttentionAction, type DeliveryAttentionKind } from '$lib/domain/mail';
import { changeDeliveryAttention, listDeliveryAttention } from '$lib/server/db/delivery-attention';
import { ApiError, apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import type { RequestHandler } from './$types';

const invalid = () => new ApiError(400, 'INVALID_ATTENTION_REQUEST', '投递异常参数无效。');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export const GET: RequestHandler = withApiHandler(async (event) => {
  const { userId } = await requireWorkspaceMailboxSession(event);
  const params = event.url.searchParams;
  const view = params.get('view') ?? 'pending';
  const kind = params.get('kind') as DeliveryAttentionKind | null;
  const limit = Number(params.get('limit') ?? 20);
  if ((view !== 'pending' && view !== 'history') || (kind !== null && !deliveryAttentionKinds.includes(kind)) ||
    !Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid();
  return apiSuccess(event, await listDeliveryAttention(getRequestEnv(event)!.DB, userId, {
    view, kind, limit, cursor: params.get('cursor')
  }));
});

export const POST: RequestHandler = withApiHandler(async (event) => {
  const { userId } = await requireWorkspaceMailboxSession(event);
  const body = await readJsonBody<unknown>(event, { maxBytes: 2048 });
  if (!isRecord(body)) throw invalid();
  let action: DeliveryAttentionAction;
  if (body.action === 'acknowledge_all' && isRecord(body.snapshot)) {
    const { asOf, version } = body.snapshot;
    if ((version !== 0 && !isVersion(version)) || typeof asOf !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(asOf) ||
      !Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString() !== asOf) throw invalid();
    action = { action: body.action, snapshot: { asOf, version } };
  } else if ((body.action === 'acknowledge' || body.action === 'reopen') && isRecord(body.incident)) {
    const { id, version } = body.incident;
    if (!isVersion(id) || !isVersion(version)) throw invalid();
    action = { action: body.action, incident: { id, version } };
  } else {
    throw invalid();
  }
  return apiSuccess(event, await changeDeliveryAttention(getRequestEnv(event)!.DB, userId, action));
});
