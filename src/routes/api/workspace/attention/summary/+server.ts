import { getDeliveryAttentionSummary } from '$lib/server/db/delivery-attention';
import { apiSuccess, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { reconcileDeferredResendEvents } from '$lib/server/workspace/delivery';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const { userId } = await requireWorkspaceMailboxSession(event);
  return apiSuccess(event, await getDeliveryAttentionSummary(getRequestEnv(event)!.DB, userId));
});

export const POST: RequestHandler = withApiHandler(async (event) => {
  const { userId } = await requireWorkspaceMailboxSession(event);
  const env = getRequestEnv(event)!;
  // Preview has no scheduled replay, so recover ready events before reading the summary.
  const replayed = await reconcileDeferredResendEvents(env, userId).catch(() => {
    console.error(JSON.stringify({ level: 'error', event: 'attention_deferred_delivery_replay_failed' }));
    return 0;
  });
  return apiSuccess(event, { ...await getDeliveryAttentionSummary(env.DB, userId), replayed });
});
