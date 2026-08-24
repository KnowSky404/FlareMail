import type { RequestHandler } from './$types';
import { validateComposeInput, type ComposeInput, MAIL_LIMITS } from '$lib/domain/mail';
import { findDeliveryStatus } from '$lib/server/db/deliveries';
import {
  ApiError,
  apiFailure,
  apiSuccess,
  fieldErrorsFromIssues,
  getRequestId,
  readJsonBody,
  withApiHandler
} from '$lib/server/http/api';
import { isOutboundGatewayError } from '$lib/server/outbound/gateway';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { OutboundRateLimitError, sendWorkspaceMessage } from '$lib/server/workspace';
import { DraftBodyReloadRequiredError, DraftConflictError } from '$lib/server/workspace/draft';
import { SafeHtmlError } from '$lib/server/mail/html-sanitize';

type SendRequest = Record<string, unknown>;

export interface SendApiResult {
  success: true;
  id: string;
  sentAt: string;
  /** The local persisted workspace message id, not the provider id. */
  messageId: string;
}

function isRecord(value: unknown): value is SendRequest {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Adapt the small MicroBin-compatible payload without creating a second mail service. */
function composeInput(value: unknown): ComposeInput {
  if (!isRecord(value)) throw new ApiError(400, 'INVALID_REQUEST', '请求正文必须是 JSON 对象。');

  const rawBody = typeof value.body === 'string'
    ? value.body
    : typeof value.text === 'string'
      ? value.text
      : '';
  const subject = typeof value.subject === 'string' ? value.subject : '';
  const { text: _text, ...rest } = value;
  return {
    ...rest,
    subject,
    body: rawBody,
    ...(typeof value.html === 'string' ? { html: value.html } : {})
  } as ComposeInput;
}

function acceptedSentAt(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new ApiError(502, 'DELIVERY_TIMESTAMP_MISSING', 'Provider accepted the message without a valid acceptance timestamp.');
  }
  return new Date(value).toISOString();
}

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const input = composeInput(await readJsonBody<unknown>(event, { maxBytes: MAIL_LIMITS.body * 2 + 512 * 1024 }));
  const validation = validateComposeInput(input);
  if (!validation.ok) {
    throw new ApiError(400, 'VALIDATION_FAILED', '邮件内容未通过验证。', fieldErrorsFromIssues(validation.issues));
  }

  try {
    const requestId = getRequestId(event);
    const idempotencyKey = event.request.headers.get('Idempotency-Key')?.trim() || requestId;
    const result = await sendWorkspaceMessage(getRequestEnv(event), session, validation.value, { requestId: idempotencyKey });
    const env = getRequestEnv(event);
    if (!env?.DB) throw new ApiError(503, 'WORKSPACE_UNAVAILABLE', '工作区存储暂不可用。');
    const delivery = await findDeliveryStatus(env.DB, session.userId, result.message.id);
    if (!delivery) {
      throw new ApiError(502, 'DELIVERY_STATUS_UNAVAILABLE', '邮件已写入工作区，但未找到 provider 投递状态。');
    }
    if (delivery.result_kind !== 'accepted') {
      throw new ApiError(502, 'DELIVERY_NOT_ACCEPTED', 'Provider 尚未接受这封邮件，未返回发送成功。');
    }
    if (!delivery.provider_message_id?.trim()) {
      throw new ApiError(502, 'PROVIDER_MESSAGE_ID_MISSING', 'Provider 已接受邮件，但未返回 provider message id。');
    }

    const compatibility: SendApiResult = {
      success: true,
      id: delivery.provider_message_id,
      sentAt: acceptedSentAt(delivery.submitted_at ?? delivery.sent_at ?? result.message.sentAt),
      messageId: result.message.id
    };
    return apiSuccess(event, result, {}, { ...compatibility });
  } catch (error) {
    if (error instanceof OutboundRateLimitError) {
      return apiFailure(
        event,
        new ApiError(429, 'SEND_RATE_LIMITED', `发送过于频繁，请在 ${error.retryAfterSeconds} 秒后重试。`),
        { headers: { 'Retry-After': String(error.retryAfterSeconds) } }
      );
    }
    if (error instanceof SafeHtmlError) {
      throw new ApiError(400, 'VALIDATION_FAILED', error.message, fieldErrorsFromIssues([{ field: 'html', message: error.message }]));
    }
    if (error instanceof DraftConflictError) {
      throw new ApiError(409, 'DRAFT_CONFLICT', '服务器版本已更新。', undefined, {
        draftId: error.current.id,
        updatedAt: error.current.sentAt
      });
    }
    if (error instanceof DraftBodyReloadRequiredError) {
      throw new ApiError(409, error.code, error.message);
    }
    if (isOutboundGatewayError(error) && error.kind === 'configuration') {
      throw new ApiError(503, 'OUTBOUND_UNAVAILABLE', '出站邮件服务尚未正确配置。');
    }
    if (isOutboundGatewayError(error) && error.kind === 'client_error') {
      if (/attachment/iu.test(error.message)) {
        throw new ApiError(409, 'ATTACHMENT_NOT_READY', '请等待所有附件上传完成后再发送。');
      }
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请求必须提供有效的 Idempotency-Key。');
    }
    if (isOutboundGatewayError(error) && error.kind === 'idempotency_conflict') {
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '相同幂等键对应了不同的发送内容。');
    }
    throw error;
  }
});
