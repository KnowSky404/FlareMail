const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/giu;
const HTML_COMMENT = /<!--[\s\S]*?-->/gu;
const RAW_URL = /\b(?:https?:\/\/|ftp:\/\/|www\.|mailto:)[^\s<>"']+/giu;

export function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export async function sha256Base64Url(value: string) {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

export async function createTelegramChallengeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = base64Url(bytes);
  return { token, tokenHash: await sha256Base64Url(token) };
}

export function normalizeTelegramId(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d{0,31}$/u.test(value)) return value;
  return null;
}

export function cleanTelegramText(value: string, fallback = '') {
  return value
    .replace(HTML_COMMENT, ' ')
    .replace(HTML_TAG, ' ')
    .replace(RAW_URL, '[链接已省略]')
    .replace(CONTROL_CHARACTERS, '')
    .replace(/\s+/gu, ' ')
    .trim() || fallback;
}

export function cleanTelegramLine(value: string, fallback = '') {
  return cleanTelegramText(value.replace(/[\r\n]+/gu, ' '), fallback);
}

export function truncateTelegramText(value: string, maxCharacters: number) {
  const chars = Array.from(value);
  if (chars.length <= maxCharacters) return value;
  return `${chars.slice(0, Math.max(0, maxCharacters - 1)).join('')}…`;
}

export function safeErrorCode(value: string) {
  return /^[a-z][a-z0-9_:-]{0,63}$/u.test(value) ? value : 'telegram_delivery_failed';
}
