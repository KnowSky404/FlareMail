import type { RequestHandler } from './$types';
import { fromInboundMessageId, isInboundMessageId, parseAddressJson, parseAddressList } from '$lib/domain/mail';
import type { MailAuthenticationResult, MailTechnicalHeader } from '$lib/domain/mail';
import { listAttachmentsForMessage } from '$lib/server/db/attachments';
import { findBodyObject } from '$lib/server/db/body';
import { readBodyObject } from '$lib/server/body';
import { findOwnedInboundMessage } from '$lib/server/db/inbound';
import { ApiError, apiSuccess, requirePathParam, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';

function parseTechnicalHeaders(value: string): MailTechnicalHeader[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const { name, value } = entry as Record<string, unknown>;
      return typeof name === 'string' && typeof value === 'string'
        ? [{ name: name.slice(0, 64), value: value.slice(0, 2048) }]
        : [];
    }).slice(0, 64);
  } catch {
    return [];
  }
}

function parseAuthenticationResults(value: string): MailAuthenticationResult[] {
  const methods = new Set(['spf', 'dkim', 'dmarc']);
  const results = new Set(['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'policy']);
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const { method, result } = entry as Record<string, unknown>;
      return typeof method === 'string' && typeof result === 'string' && methods.has(method) && results.has(result)
        ? [{ method, result } as MailAuthenticationResult]
        : [];
    }).slice(0, 12);
  } catch {
    return [];
  }
}

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  const routeMessageId = requirePathParam(event, 'id');
  if (!isInboundMessageId(routeMessageId)) throw new ApiError(404, 'INBOUND_DETAIL_NOT_FOUND', '当前邮件不支持加载入站详情。');
  if (!env?.DB) throw new ApiError(503, 'INBOUND_STORAGE_UNAVAILABLE', '入站存储服务暂不可用。');
  const messageId = fromInboundMessageId(routeMessageId);
  const record = await findOwnedInboundMessage(env.DB, session.userId, messageId);
  if (!record) throw new ApiError(404, 'INBOUND_MESSAGE_NOT_FOUND', '找不到对应的入站邮件。');
  let body = record.text_body.trim() || record.snippet;
  let hasHtml = Boolean(record.html_body.trim());
  if (record.body_object_id) {
    if (!env.BUCKET) throw new ApiError(503, 'INBOUND_STORAGE_UNAVAILABLE', '入站正文存储服务暂不可用。');
    const object = await findBodyObject(env.DB, record.body_object_id, session.userId, 'email_message', messageId);
    if (!object) throw new ApiError(404, 'BODY_OBJECT_NOT_FOUND', '入站正文对象不存在。');
    try {
      const canonical = await readBodyObject(env.BUCKET, object.r2_key, object.size_bytes, object.sha256);
      body = canonical.textBody;
      hasHtml = Boolean(canonical.htmlBody.trim());
    } catch (error) {
      throw new ApiError(409, 'BODY_OBJECT_INTEGRITY', '入站正文完整性校验失败。', undefined, { reason: error instanceof Error ? error.message : 'unknown' });
    }
  }
  const attachments = await listAttachmentsForMessage(env.DB, session.userId, messageId);
  const storedToAddresses = parseAddressJson(record.to_json);
  const storedCcAddresses = parseAddressJson(record.cc_json);
  return apiSuccess(event, {
    detail: {
      body,
      rawSize: record.raw_size,
      hasHtml,
      toAddresses: storedToAddresses.length ? storedToAddresses : parseAddressList(record.to),
      ccAddresses: storedCcAddresses.length ? storedCcAddresses : parseAddressList(record.cc),
      replyTo: parseAddressJson(record.reply_to_json),
      date: record.timestamp,
      messageId: record.message_id,
      inReplyTo: record.in_reply_to,
      references: record.references,
      returnPath: record.return_path,
      deliveredTo: record.delivered_to,
      headers: parseTechnicalHeaders(record.headers_json),
      authenticationResults: parseAuthenticationResults(record.authentication_results_json),
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.content_type,
        size: attachment.size,
        inline: Boolean(attachment.inline),
        contentId: attachment.content_id,
        downloadUrl: `/api/workspace/messages/${encodeURIComponent(routeMessageId)}/attachments/${encodeURIComponent(attachment.id)}`
      }))
    }
  });
});
