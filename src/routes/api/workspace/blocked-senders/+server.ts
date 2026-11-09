import type { RequestHandler } from './$types';
import { addBlockedSender, listBlockedSenders, removeBlockedSender } from '$lib/server/db/blocked-senders';
import { apiSuccess, readJsonBody, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  return apiSuccess(event, { senders: await listBlockedSenders(getRequestEnv(event)!.DB, session.userId) });
});

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const body = await readJsonBody<{ email?: unknown }>(event, { maxBytes: 1024 });
  const email = await addBlockedSender(getRequestEnv(event)!.DB, session.userId, body?.email);
  return apiSuccess(event, { email });
});

export const DELETE: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const body = await readJsonBody<{ email?: unknown }>(event, { maxBytes: 1024 });
  await removeBlockedSender(getRequestEnv(event)!.DB, session.userId, typeof body?.email === 'string' ? body.email : '');
  return apiSuccess(event, { removed: true });
});
