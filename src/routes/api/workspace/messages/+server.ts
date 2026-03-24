import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { ComposeInput } from '$lib/mock/mailbox';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';
import { sendWorkspaceMessage } from '$lib/server/workspace';

export const POST: RequestHandler = async (event) => {
  const session = requireWorkspaceSession(event);
  const payload = (await event.request.json()) as ComposeInput;
  const env = getRequestEnv(event);

  if (!payload.toEmail.trim() || !payload.subject.trim() || !payload.body.trim()) {
    return json(
      {
        ok: false,
        error: '收件人、主题和正文不能为空。'
      },
      { status: 400 }
    );
  }

  return json({
    ok: true,
    ...(await sendWorkspaceMessage(env, session, payload))
  });
};
