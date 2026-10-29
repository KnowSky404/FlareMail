import { fromInboundMessageId, isInboundMessageId } from '$lib/domain/mail';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { findBodyObject } from '$lib/server/db/body';
import { listAttachmentsForMessage } from '$lib/server/db/attachments';
import { findOwnedInboundMessage } from '$lib/server/db/inbound';
import { ApiError } from '$lib/server/http/api';
import { readBodyObject } from '$lib/server/body';
import { SafeHtmlError, sanitizeHtml, type SafeHtmlResult } from '$lib/server/mail/html-sanitize';
import { createCidAttachmentUrls } from '$lib/server/workspace/cid-capability';
import type { WorkspaceContext } from '$lib/server/workspace/shared';

export const SAFE_INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp'
]);

function normalizeContentId(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/^<|>$/gu, '').trim().toLowerCase();
  return normalized && !/[\u0000-\u001f\u007f]/u.test(normalized) ? normalized : null;
}

function safeHtmlDocument(result: SafeHtmlResult): string {
  const imageNotice = result.allowedRemoteImages
    ? `<p class="fm-privacy-note">已按你的选择加载 ${result.allowedRemoteImages} 个远程图片。图片服务器可能记录你的 IP 地址和打开时间。</p>`
    : result.blockedImages
      ? `<p class="fm-privacy-note">已阻止 ${result.blockedImages} 个未授权或不安全的图片。内联 CID 图片仅在当前邮件归属校验通过时显示。</p>`
      : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="referrer" content="no-referrer">
  <title>安全 HTML 邮件视图</title>
  <style>
    :root { color-scheme: light; font-family: Arial, Helvetica, sans-serif; }
    body { margin: 0; padding: 16px; color: #222; background: #fff; font-size: 14px; line-height: 1.5; }
    .fm-email-content { min-width: 0; overflow: auto; overflow-wrap: break-word; }
    .fm-email-content img { max-width: 100%; height: auto; }
    .fm-email-content pre { overflow: auto; }
    a { color: #1558b0; }
    .fm-privacy-note { margin: 0 0 16px; padding: 10px 12px; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 8px; font-size: 12px; }
    .fm-link-target { font-size: .78em; color: GrayText; white-space: nowrap; }
    .fm-link-warning { font-size: .78em; color: #b45309; font-weight: 600; }
    @media (max-width: 480px) { body { padding: 8px; } }
    @media print { body { padding: 0; } .fm-privacy-note { display: none; } a { color: inherit; } }
  </style>
  <style>${result.styles}</style>
</head>
<body>${imageNotice}${result.linkNotices ? `<aside class="fm-link-notices" aria-label="链接目标及风险">${result.linkNotices}</aside>` : ''}<div class="fm-email-content">${result.html || '<p>这封邮件没有可显示的 HTML 正文。</p>'}</div></body>
</html>`;
}

export async function renderOwnedSafeHtml(
  env: CloudflareEnv | undefined,
  session: WorkspaceContext,
  routeMessageId: string,
  options: { allowRemoteImages?: boolean } = {}
) {
  if (!isInboundMessageId(routeMessageId)) {
    throw new ApiError(404, 'HTML_BODY_NOT_FOUND', '当前邮件没有可读取的 HTML 正文。');
  }
  if (!env?.DB) throw new ApiError(503, 'HTML_STORAGE_UNAVAILABLE', 'HTML 正文存储服务暂不可用。');
  const messageId = fromInboundMessageId(routeMessageId);
  const record = await findOwnedInboundMessage(env.DB, session.userId, messageId);
  if (!record) throw new ApiError(404, 'INBOUND_MESSAGE_NOT_FOUND', '找不到对应的入站邮件。');

  let html = record.html_body;
  if (record.body_object_id) {
    if (!env.BUCKET) throw new ApiError(503, 'HTML_STORAGE_UNAVAILABLE', 'HTML 正文存储服务暂不可用。');
    const object = await findBodyObject(env.DB, record.body_object_id, session.userId, 'email_message', messageId);
    if (!object) throw new ApiError(404, 'BODY_OBJECT_NOT_FOUND', '入站正文对象不存在。');
    try {
      html = (await readBodyObject(env.BUCKET, object.r2_key, object.size_bytes, object.sha256)).htmlBody;
    } catch {
      throw new ApiError(409, 'BODY_OBJECT_INTEGRITY', '入站正文完整性校验失败。');
    }
  }
  if (!html.trim()) throw new ApiError(404, 'HTML_BODY_NOT_FOUND', '当前邮件没有可读取的 HTML 正文。');

  const attachments = await listAttachmentsForMessage(env.DB, session.userId, messageId);
  const inlineAttachments = attachments.filter((attachment) => {
    const cid = normalizeContentId(attachment.content_id);
    const contentType = attachment.content_type.trim().toLowerCase();
    return cid && attachment.inline && SAFE_INLINE_IMAGE_TYPES.has(contentType);
  });
  const attachmentUrls = await createCidAttachmentUrls(
    env.DB,
    session,
    routeMessageId,
    inlineAttachments.map((attachment) => attachment.id)
  );
  const cidUrls = new Map<string, string>();
  for (const attachment of inlineAttachments) {
    const cid = normalizeContentId(attachment.content_id);
    const attachmentUrl = attachmentUrls.get(attachment.id);
    if (!cid || !attachmentUrl || cidUrls.has(cid)) continue;
    cidUrls.set(cid, attachmentUrl);
  }

  let sanitized: SafeHtmlResult;
  try {
    sanitized = sanitizeHtml(html, {
      preserveStyles: true,
      allowRemoteImages: options.allowRemoteImages === true,
      resolveCidImage: (cid) => cidUrls.get(normalizeContentId(cid) ?? '') ?? null
    });
  } catch (error) {
    if (error instanceof SafeHtmlError) {
      throw new ApiError(422, 'HTML_SAFETY_LIMIT', 'HTML 正文超过安全显示限制，请继续使用纯文本视图。');
    }
    throw error;
  }
  return { document: safeHtmlDocument(sanitized), sanitized };
}
