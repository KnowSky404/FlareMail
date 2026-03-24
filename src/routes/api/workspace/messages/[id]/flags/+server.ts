import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { MessagePatch } from '$lib/mock/mailbox';
import { requireWorkspaceSession } from '$lib/server/workspace-api';
import { patchWorkspaceMessage } from '$lib/server/workspace';

export const PATCH: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);
  const payload = (await event.request.json()) as MessagePatch;
  const result = patchWorkspaceMessage(session, event.params.id, payload);

  if (!result) {
    return json(
      {
        ok: false,
        error: '邮件不存在。'
      },
      { status: 404 }
    );
  }

  return json({
    ok: true,
    ...result
  });
};
