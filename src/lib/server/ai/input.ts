import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import type { MailAiInput } from '$lib/domain/mail/ai';

/** parse5 never executes scripts or fetches remote images/styles. */
export function aiHtmlText(html: string): string {
  const text: string[] = [];
  // Iterative traversal also handles deeply nested, untrusted HTML in V8.
  const stack: Array<DefaultTreeAdapterTypes.Node | null> = [parseFragment(html.slice(0, 128 * 1024))];
  while (stack.length) {
    const node = stack.pop();
    if (!node) { text.push(' '); continue; }
    if ('tagName' in node && ['script', 'style', 'template', 'noscript', 'svg', 'math', 'head'].includes(node.tagName)) continue;
    if (node.nodeName === '#text' && 'value' in node) text.push(node.value);
    if ('childNodes' in node) {
      stack.push(null);
      for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push(node.childNodes[index]);
    }
  }
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
