import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import type { MailAiInput } from '$lib/domain/mail/ai';

/** parse5 never executes scripts or fetches remote images/styles. */
export function aiHtmlText(html: string): string {
  const text: string[] = [];
  function visit(node: DefaultTreeAdapterTypes.Node) {
    if ('tagName' in node && ['script', 'style', 'template', 'noscript', 'svg', 'math', 'head'].includes(node.tagName)) return;
    if (node.nodeName === '#text' && 'value' in node) text.push(node.value);
    if ('childNodes' in node) {
      for (const child of node.childNodes) visit(child);
      text.push(' ');
    }
  }
  // Bound parsing work even when the canonical HTML is very large.
  visit(parseFragment(html.slice(0, 128 * 1024)));
  return text.join('').replace(/\s+/gu, ' ').trim();
}

export function prepareMailAiInput(
  subject: string, sender: string, textBody: string, htmlBody: string,
  language: MailAiInput['language'], maxInputChars: number
): MailAiInput {
  const body = textBody.trim() || aiHtmlText(htmlBody);
  return {
    subject: subject.slice(0, 512), sender: sender.slice(0, 320),
    body: body.slice(0, maxInputChars), language,
    truncated: body.length > maxInputChars || (!textBody.trim() && htmlBody.length > 128 * 1024)
  };
}

export async function mailAiFingerprint(input: MailAiInput, model: string, baseUrl: string, version: number) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ input, model, baseUrl, version })));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
