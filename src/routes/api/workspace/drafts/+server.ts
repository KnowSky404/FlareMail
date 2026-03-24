import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { ComposeInput } from '$lib/mock/mailbox';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';
import { saveWorkspaceDraft } from '$lib/server/workspace';

export const POST: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);
  const payload = (await event.request.json()) as ComposeInput;
  const env = getRequestEnv(event);

  return json({
    ok: true,
    ...(await saveWorkspaceDraft(env, session, payload))
  });
};
