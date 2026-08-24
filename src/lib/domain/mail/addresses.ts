/** Canonical mailbox address model shared by compose, storage and providers. */
export interface MailAddress {
  name: string;
  email: string;
}

export type MailAddressInput = MailAddress | string;

export const MAX_RECIPIENTS = 50;
export const MAX_DISPLAY_NAME_LENGTH = 200;

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const UNSAFE_DISPLAY_NAME_RE = /[\u0000-\u001f\u007f]/u;

export function normalizeMailboxEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidMailboxEmail(value: string): boolean {
  if (/[^\x00-\x7f]/u.test(value.trim())) return false;
  const email = normalizeMailboxEmail(value);
  if (!email || email.length > 254 || /[\r\n\0]/u.test(email)) return false;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at !== email.indexOf('@') || at > 64 || email.length - at - 1 > 253) return false;
  const local = email.slice(0, at);
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  return EMAIL_RE.test(email);
}

function splitAddressTokens(value: string): string[] {
  const tokens: string[] = [];
  let start = 0;
  let quote = false;
  let escaped = false;
  let angleDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quote = !quote;
      continue;
    }
    if (!quote && character === '<') {
      angleDepth += 1;
      continue;
    }
    if (!quote && character === '>' && angleDepth > 0) {
      angleDepth -= 1;
      continue;
    }
    if (!quote && angleDepth === 0 && /[,;，；\r\n]/u.test(character)) {
      const token = value.slice(start, index).trim();
      if (token) tokens.push(token);
      start = index + 1;
    }
  }

  const finalToken = value.slice(start).trim();
  if (finalToken) tokens.push(finalToken);
  return tokens;
}

function unquoteName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\([\\"])/gu, '$1').trim();
  }
  return trimmed;
}

function normalizeDisplayName(value: string): string | null {
  const name = unquoteName(value);
  if (name.length > MAX_DISPLAY_NAME_LENGTH || UNSAFE_DISPLAY_NAME_RE.test(name)) return null;
  return name;
}

function parseAddressToken(token: string): MailAddress | null {
  const angle = token.match(/^(.*?)\s*<([^<>]+)>$/u);
  const rawName = angle?.[1] ?? '';
  const rawEmail = angle?.[2] ?? token;
  const email = normalizeMailboxEmail(rawEmail);
  const name = normalizeDisplayName(rawName);
  if (!isValidMailboxEmail(rawEmail) || name === null) return null;
  return { name, email };
}

/** Parse only explicit delimiters; whitespace inside a display name is preserved. */
function isMailAddress(value: unknown): value is MailAddress {
  return typeof value === 'object' && value !== null &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    typeof (value as Record<string, unknown>).email === 'string';
}

export function parseAddressList(value: unknown): MailAddress[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry === 'string') return splitAddressTokens(entry).flatMap((token) => {
        const parsed = parseAddressToken(token);
        return parsed ? [parsed] : [];
      });
      if (!isMailAddress(entry)) return [];
      const email = normalizeMailboxEmail(entry.email);
      const name = normalizeDisplayName(entry.name);
      return isValidMailboxEmail(entry.email) && name !== null ? [{ name, email }] : [];
    });
  }
  return splitAddressTokens(typeof value === 'string' ? value : '').flatMap((token) => {
    const parsed = parseAddressToken(token);
    return parsed ? [parsed] : [];
  });
}

/** Parse while retaining invalid tokens for field-level validation messages. */
export function inspectAddressList(value: unknown) {
  const entries: Array<{ input: unknown; address: MailAddress | null }> = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') {
        for (const token of splitAddressTokens(entry)) entries.push({ input: token, address: parseAddressToken(token) });
      } else if (isMailAddress(entry)) {
        const email = normalizeMailboxEmail(entry.email);
        const name = normalizeDisplayName(entry.name);
        entries.push({ input: entry, address: isValidMailboxEmail(entry.email) && name !== null ? { name, email } : null });
      } else {
        entries.push({ input: entry, address: null });
      }
    }
  } else if (value !== null && value !== undefined && typeof value !== 'string') {
    entries.push({ input: value, address: null });
  } else {
    for (const token of splitAddressTokens(typeof value === 'string' ? value : '')) entries.push({ input: token, address: parseAddressToken(token) });
  }
  return entries;
}

export function dedupeAddresses(addresses: readonly MailAddress[]): MailAddress[] {
  const seen = new Set<string>();
  return addresses.filter((address) => {
    if (seen.has(address.email)) return false;
    seen.add(address.email);
    return true;
  });
}

function quoteDisplayName(name: string): string {
  const escaped = name.replace(/[\\"]/gu, '\\$&');
  return /^[\p{L}\p{N} _'-]+$/u.test(name) ? name : `"${escaped}"`;
}

export function serializeAddress(address: MailAddress): string {
  return address.name ? `${quoteDisplayName(address.name)} <${address.email}>` : address.email;
}

export function serializeAddressList(addresses: readonly MailAddress[]): string {
  return addresses.map(serializeAddress).join(', ');
}

export function serializeAddressJson(addresses: readonly MailAddress[]): string {
  return JSON.stringify(addresses.map(({ name, email }) => ({ name, email })));
}

export function parseAddressJson(value: string | null | undefined): MailAddress[] {
  if (!value?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parseAddressList(parsed) : [];
  } catch {
    return [];
  }
}
