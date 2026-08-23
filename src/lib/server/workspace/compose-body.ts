import type { ComposeInput } from '$lib/domain/mail';
import { SafeHtmlError, sanitizeHtml } from '$lib/server/mail/html-sanitize';

/**
 * Normalize a compose payload at the trust boundary. HTML is only ever sent to
 * the provider after passing the same sanitizer used by the safe HTML reader;
 * outbound mode deliberately omits reader-only link-risk decorations and
 * leaves remote images blocked by default.
 */
export function sanitizeComposeInput(input: ComposeInput): ComposeInput {
  const sourceHtml = typeof input.html === 'string' ? input.html.trim() : '';
  const sanitized = sourceHtml
    ? sanitizeHtml(sourceHtml, { allowRemoteImages: false, decorateLinks: false })
    : null;
  const body = input.body.trim() || sanitized?.text || '';
  const html = sanitized?.html ?? '';
  if ((input.body.trim() || sourceHtml) && !body.trim() && !html.trim()) {
    throw new SafeHtmlError('HTML_CONTENT_EMPTY', 'HTML 清洗后没有可发送的正文内容。');
  }
  return {
    ...input,
    body,
    ...(typeof input.html === 'string' ? { html } : {})
  };
}
