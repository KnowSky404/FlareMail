/** Workers-compatible opaque token helpers. Store only the digest. */

const TOKEN_BYTES = 32;

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function fromString(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Generate a URL-safe token with at least 256 bits of entropy. */
export function generateSessionToken(bytes = TOKEN_BYTES): string {
  if (!Number.isSafeInteger(bytes) || bytes < TOKEN_BYTES || bytes > 1024) {
    throw new RangeError(`Token entropy must be between ${TOKEN_BYTES} and 1024 bytes.`);
  }
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Return the stable SHA-256 base64url digest suitable for a D1 session row. */
export async function hashSessionToken(token: string): Promise<string> {
  if (typeof token !== 'string' || token.length === 0) throw new TypeError('Session token must be a non-empty string.');
  return toBase64Url(await crypto.subtle.digest('SHA-256', copyBuffer(fromString(token))));
}

export const generateToken = generateSessionToken;
export const hashToken = hashSessionToken;
