import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { ResendWebhookError, verifyResendWebhook } from '$lib/server/resend-webhook';
import { applyResendDeliveryWebhook } from '$lib/server/workspace';
import { DeliveryPersistenceError } from '$lib/server/workspace/delivery';

export function _classifyWebhookProcessingError(error: unknown) {
  if (error instanceof ResendWebhookError) {
    return { status: 400 as const, code: error.code, message: 'Webhook payload is invalid.' };
  }
  if (error instanceof DeliveryPersistenceError) {
    return { status: 503 as const, code: error.code, message: 'Webhook persistence is temporarily unavailable.' };
  }
  const transient = error instanceof Error && /D1|database|SQLITE|storage|temporar|timeout/iu.test(error.message);
  return transient
    ? { status: 503 as const, code: 'WEBHOOK_STORAGE_UNAVAILABLE', message: 'Webhook persistence is temporarily unavailable.' }
    : { status: 500 as const, code: 'WEBHOOK_INTERNAL_ERROR', message: 'Webhook processing failed.' };
}

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

  const declaredLength = Number(event.request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > 256 * 1024) {
    return json({ ok: false, code: 'WEBHOOK_BODY_TOO_LARGE', error: 'Webhook body is too large.' }, { status: 413 });
  }
  const body = await event.request.text();
  if (new TextEncoder().encode(body).byteLength > 256 * 1024) {
    return json({ ok: false, code: 'WEBHOOK_BODY_TOO_LARGE', error: 'Webhook body is too large.' }, { status: 413 });
  }

  let verified;
  try {
    verified = await verifyResendWebhook(body, event.request.headers, secret);
  } catch (error) {
    const webhookError = error instanceof ResendWebhookError ? error : null;
    const status = webhookError?.code === 'missing_config'
      ? 503
      : webhookError && ['invalid_signature', 'expired'].includes(webhookError.code) ? 401 : 400;
    return json({ ok: false, code: webhookError?.code ?? 'INVALID_WEBHOOK', error: 'Webhook verification failed.' }, { status });
  }

  try {
    const result = await applyResendDeliveryWebhook(env, verified.svixId, verified.payload);
    return json({
      ok: true,
      ...result
    });
  } catch (error) {
    const classified = _classifyWebhookProcessingError(error);
    return json(
      {
        ok: false,
        code: classified.code,
        error: classified.message
      },
      { status: classified.status }
    );
  }
};
