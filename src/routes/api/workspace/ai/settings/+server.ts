import type { RequestHandler } from './$types';
import { apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { readMailAiSettings, requireAiSettingsOwner, saveMailAiSettings } from '$lib/server/ai/settings';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const env = getRequestEnv(event)!;
  await requireAiSettingsOwner(env, session.userId);
  return apiSuccess(event, await readMailAiSettings(env, session.userId));
});
export const PATCH: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const env = getRequestEnv(event)!;
  await requireAiSettingsOwner(env, session.userId);
  const body = await readJsonBody<unknown>(event, { maxBytes: 12 * 1024 });
  return apiSuccess(event, await saveMailAiSettings(env, session.userId, body));
});
