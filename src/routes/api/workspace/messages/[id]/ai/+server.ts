import type { RequestHandler } from './$types';
import { ApiError, apiSuccess, readJsonBody, requirePathParam, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { workspaceMailAi } from '$lib/server/workspace/ai';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const language = event.url.searchParams.get('language') ?? event.locals.locale ?? 'zh-CN';
  if (language !== 'zh-CN' && language !== 'en') throw new ApiError(400, 'AI_INVALID_LANGUAGE', 'Unsupported analysis language.');
  return apiSuccess(event, await workspaceMailAi(getRequestEnv(event)!, session, requirePathParam(event, 'id'), { language }));
});

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const body = await readJsonBody<Record<string, unknown>>(event, { maxBytes: 1024 });
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
    Object.keys(body).some((key) => !['language', 'regenerate'].includes(key)) ||
    (body.regenerate !== undefined && typeof body.regenerate !== 'boolean') ||
    (typeof body.language !== 'string' || !['zh-CN', 'en'].includes(body.language))) throw new ApiError(400, 'AI_INVALID_REQUEST', 'Invalid analysis request.');
  return apiSuccess(event, await workspaceMailAi(getRequestEnv(event)!, session, requirePathParam(event, 'id'), {
    language: body.language as 'zh-CN' | 'en', analyze: true, regenerate: body.regenerate as boolean | undefined
  }));
});
