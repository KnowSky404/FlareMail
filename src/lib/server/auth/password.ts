/**
 * Password hashing primitives that are available in both Workers and the
 * browser.  In particular, this module deliberately does not import
 * Node's `crypto` module: Cloudflare's Web Crypto implementation is the
 * runtime used in production.
 */

export const PASSWORD_HASH_ALGORITHM = 'PBKDF2-HMAC-SHA-256' as const;
export const PASSWORD_HASH_VERSION = 1 as const;
export const PASSWORD_SALT_BYTES = 16;
export const PASSWORD_KEY_BITS = 256;

// OWASP's PBKDF2-HMAC-SHA-256 recommendation is 600,000 iterations.  Keep
// the value in the encoded hash so it can be increased without invalidating
// existing credentials.
export const PASSWORD_HASH_ITERATIONS = 600_000;

const encoder = new TextEncoder();
const HASH_PREFIX = `pbkdf2-sha256-v${PASSWORD_HASH_VERSION}`;

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new Error('Invalid base64url value.');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function assertPassword(password: string): void {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('Password must be a non-empty string.');
  }
}

function assertIterations(iterations: number): void {
  if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 10_000_000) {
    throw new RangeError('PBKDF2 iterations must be between 100000 and 10000000.');
  }
}

async function derivePasswordKey(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', copyBuffer(encoder.encode(password)), { name: 'PBKDF2' }, false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: copyBuffer(salt), iterations, hash: 'SHA-256' }, key, PASSWORD_KEY_BITS);
}

/** Hash a password as `algorithm$iterations$salt$digest` using base64url. */
export async function hashPassword(
  password: string,
  options: { iterations?: number; saltBytes?: number } = {}
): Promise<string> {
  assertPassword(password);
  const iterations = options.iterations ?? PASSWORD_HASH_ITERATIONS;
  const saltBytes = options.saltBytes ?? PASSWORD_SALT_BYTES;
  assertIterations(iterations);
  if (!Number.isSafeInteger(saltBytes) || saltBytes < PASSWORD_SALT_BYTES || saltBytes > 1024) {
    throw new RangeError(`Password salt must be between ${PASSWORD_SALT_BYTES} and 1024 bytes.`);
  }

  const salt = crypto.getRandomValues(new Uint8Array(saltBytes));
  const digest = await derivePasswordKey(password, salt, iterations);
  return [HASH_PREFIX, String(iterations), toBase64Url(salt), toBase64Url(digest)].join('$');
}

/**
 * Compare two byte arrays without an early return.  The length is folded into
 * the accumulator, and the loop still visits the longer input on mismatch.
 */
export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index % (left.length || 1)] ?? 0) ^ (right[index % (right.length || 1)] ?? 0);
  }
  return difference === 0;
}

/** Verify a password hash. Malformed/unrecognised hashes return false. */
export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof encodedHash !== 'string') return false;
  const [prefix, iterationText, encodedSalt, encodedDigest, ...extra] = encodedHash.split('$');
  if (prefix !== HASH_PREFIX || !iterationText || !encodedSalt || !encodedDigest || extra.length > 0) return false;

  const iterations = Number(iterationText);
  if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 10_000_000) return false;

  let salt: Uint8Array;
  let expectedDigest: Uint8Array;
  try {
    salt = fromBase64Url(encodedSalt);
    expectedDigest = fromBase64Url(encodedDigest);
  } catch {
    return false;
  }
  if (salt.length < PASSWORD_SALT_BYTES || expectedDigest.length !== PASSWORD_KEY_BITS / 8) return false;

  try {
    const actualDigest = new Uint8Array(await derivePasswordKey(password, salt, iterations));
    return constantTimeEqual(actualDigest, expectedDigest);
  } catch {
    return false;
  }
}

export function isPasswordHash(value: string): boolean {
  return typeof value === 'string' && value.startsWith(`${HASH_PREFIX}$`);
}
