import { getDeliveryAttentionSummary } from '$lib/server/db/delivery-attention';
import { ApiError, apiSuccess, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { reconcileDeferredResendEvents } from '$lib/server/workspace/delivery';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const { userId } = await requireWorkspaceMailboxSession(event);
  return apiSuccess(event, await getDeliveryAttentionSummary(getRequestEnv(event)!.DB, userId));
});

export const POST: RequestHandler = withApiHandler(async (event) => {
  const { userId } = await requireWorkspaceMailboxSession(event);
  const messageIds = event.url.searchParams.getAll('messageId');
  const messageId = messageIds[0];
  if (messageIds.length > 1 || (messageId !== undefined && !/^[A-Za-z0-9:._-]{1,128}$/u.test(messageId))) {
    throw new ApiError(400, 'INVALID_ATTENTION_REQUEST', '投递异常参数无效。');
  }
  const env = getRequestEnv(event)!;
  // Preview has no scheduled replay, so recover ready events before reading the summary.
  let replayFailed = false;
  const onFailure = () => {
    replayFailed = true;
    console.error(JSON.stringify({ level: 'error', event: 'attention_deferred_delivery_replay_failed' }));
  };
  const replayed = await reconcileDeferredResendEvents(env, { userId, messageId, onFailure }).catch(() => {
    onFailure();
    return 0;
  });
  return apiSuccess(event, {
    ...await getDeliveryAttentionSummary(env.DB, userId), replayed, ...(replayFailed ? { replayFailed: true } : {})
  });
});
