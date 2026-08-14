import type { RequestHandler } from './$types';
import { validateComposeInput, type ComposeInput } from '$lib/domain/mail';
import {
  ApiError,
  apiSuccess,
  fieldErrorsFromIssues,
  readJsonBody,
  withApiHandler
} from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import { sendWorkspaceMessage } from '$lib/server/workspace';
import { isOutboundGatewayError } from '$lib/server/outbound/gateway';
import { MAIL_LIMITS } from '$lib/domain/mail';

export const POST: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const validation = validateComposeInput(await readJsonBody<ComposeInput>(event, { maxBytes: MAIL_LIMITS.body * 4 + 32 * 1024 }));
  if (!validation.ok) {
    throw new ApiError(400, 'VALIDATION_FAILED', '邮件内容未通过验证。', fieldErrorsFromIssues(validation.issues));
  }
  try {
    const result = await sendWorkspaceMessage(getRequestEnv(event), session, validation.value, {
      requestId: event.request.headers.get('Idempotency-Key')
    });
    return apiSuccess(event, result);
  } catch (error) {
    if (isOutboundGatewayError(error) && error.kind === 'configuration') {
      throw new ApiError(503, 'OUTBOUND_UNAVAILABLE', '出站邮件服务尚未正确配置。');
    }
    if (isOutboundGatewayError(error) && error.kind === 'client_error') {
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '新邮件必须提供有效的 Idempotency-Key。');
    }
    if (isOutboundGatewayError(error) && error.kind === 'idempotency_conflict') {
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '相同幂等键对应了不同的发送内容。');
    }
    throw error;
  }
});
