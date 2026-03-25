import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { verifyResendWebhook } from '$lib/server/resend-webhook';
import { applyResendDeliveryWebhook } from '$lib/server/workspace';

export const POST: RequestHandler = async (event) => {
  const env = event.platform?.env as CloudflareEnv | undefined;
  const secret = env?.RESEND_WEBHOOK_SECRET?.trim();

  if (!secret) {
    return json(
      {
        ok: false,
        error: '运行时缺少 RESEND_WEBHOOK_SECRET。'
      },
      { status: 503 }
    );
  }

  const body = await event.request.text();

  try {
    const verified = await verifyResendWebhook(body, event.request.headers, secret);
    const result = await applyResendDeliveryWebhook(env, verified.svixId, verified.payload);

    return json({
      ok: true,
      ...result
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Webhook 处理失败。'
      },
      { status: 400 }
    );
  }
};
