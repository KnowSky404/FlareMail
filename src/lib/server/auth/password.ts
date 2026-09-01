import { pbkdf2, scrypt } from 'node:crypto';

/** Password hashing primitives for server-side Workers code. */

export const PASSWORD_HASH_ALGORITHM = 'scrypt' as const;
export const PASSWORD_HASH_VERSION = 1 as const;
export const PASSWORD_SALT_BYTES = 16;
export const PASSWORD_KEY_BITS = 256;

// This is OWASP's 64 MiB scrypt profile. Cloudflare Workers does not support
// Argon2 and caps PBKDF2 at 100,000 iterations, below OWASP's 600,000-iteration
// PBKDF2-HMAC-SHA-256 profile.
export const PASSWORD_HASH_COST = 65_536;
export const PASSWORD_HASH_BLOCK_SIZE = 8;
export const PASSWORD_HASH_PARALLELIZATION = 2;
export const PASSWORD_HASH_MAX_MEMORY_BYTES = 96 * 1024 * 1024;

const encoder = new TextEncoder();
const HASH_PREFIX = `scrypt-v${PASSWORD_HASH_VERSION}`;
const LEGACY_PBKDF2_PREFIX = 'pbkdf2-sha256-v1';

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

function assertScryptParameters(cost: number, blockSize: number, parallelization: number): void {
  if (
    cost !== PASSWORD_HASH_COST ||
    blockSize !== PASSWORD_HASH_BLOCK_SIZE ||
    parallelization !== PASSWORD_HASH_PARALLELIZATION
  ) {
    throw new RangeError('Unsupported scrypt password-hash parameters.');
  }
}

async function deriveScryptKey(
  password: string,
  salt: Uint8Array,
  cost: number,
  blockSize: number,
  parallelization: number
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      encoder.encode(password),
      salt,
      PASSWORD_KEY_BITS / 8,
      {
        N: cost,
        r: blockSize,
        p: parallelization,
        maxmem: PASSWORD_HASH_MAX_MEMORY_BYTES
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(copyBuffer(derivedKey));
      }
    );
  });
}

async function deriveLegacyPbkdf2Key(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(encoder.encode(password), salt, iterations, PASSWORD_KEY_BITS / 8, 'sha256', (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(copyBuffer(derivedKey));
    });
  });
}

const DUMMY_PASSWORD_HASH = [
  HASH_PREFIX,
  String(PASSWORD_HASH_COST),
  String(PASSWORD_HASH_BLOCK_SIZE),
  String(PASSWORD_HASH_PARALLELIZATION),
  toBase64Url(new Uint8Array(PASSWORD_SALT_BYTES)),
  toBase64Url(new Uint8Array(PASSWORD_KEY_BITS / 8))
].join('$');

/** A valid non-secret hash used to equalise work for unknown login accounts. */
export function getDummyPasswordHash(): string {
  return DUMMY_PASSWORD_HASH;
}

/** Hash a password as `algorithm$N$r$p$salt$digest` using base64url. */
export async function hashPassword(
  password: string,
  options: { saltBytes?: number } = {}
): Promise<string> {
  assertPassword(password);
  const saltBytes = options.saltBytes ?? PASSWORD_SALT_BYTES;
  if (!Number.isSafeInteger(saltBytes) || saltBytes < PASSWORD_SALT_BYTES || saltBytes > 1024) {
    throw new RangeError(`Password salt must be between ${PASSWORD_SALT_BYTES} and 1024 bytes.`);
  }

  const salt = crypto.getRandomValues(new Uint8Array(saltBytes));
  const digest = await deriveScryptKey(
    password,
    salt,
    PASSWORD_HASH_COST,
    PASSWORD_HASH_BLOCK_SIZE,
    PASSWORD_HASH_PARALLELIZATION
  );
  return [
    HASH_PREFIX,
    String(PASSWORD_HASH_COST),
    String(PASSWORD_HASH_BLOCK_SIZE),
    String(PASSWORD_HASH_PARALLELIZATION),
    toBase64Url(salt),
    toBase64Url(digest)
  ].join('$');
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

async function verifyScryptPassword(password: string, encodedHash: string): Promise<boolean> {
  const [prefix, costText, blockSizeText, parallelizationText, encodedSalt, encodedDigest, ...extra] =
    encodedHash.split('$');
  if (
    prefix !== HASH_PREFIX ||
    !costText ||
    !blockSizeText ||
    !parallelizationText ||
    !encodedSalt ||
    !encodedDigest ||
    extra.length > 0
  ) {
    return false;
  }

  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelization = Number(parallelizationText);
  try {
    assertScryptParameters(cost, blockSize, parallelization);
  } catch {
    return false;
  }

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
    const actualDigest = new Uint8Array(
      await deriveScryptKey(password, salt, cost, blockSize, parallelization)
    );
    return constantTimeEqual(actualDigest, expectedDigest);
  } catch {
    return false;
  }
}

async function verifyLegacyPbkdf2Password(password: string, encodedHash: string): Promise<boolean> {
  const [prefix, iterationText, encodedSalt, encodedDigest, ...extra] = encodedHash.split('$');
  if (prefix !== LEGACY_PBKDF2_PREFIX || !iterationText || !encodedSalt || !encodedDigest || extra.length > 0) {
    return false;
  }

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
    const actualDigest = new Uint8Array(await deriveLegacyPbkdf2Key(password, salt, iterations));
    return constantTimeEqual(actualDigest, expectedDigest);
  } catch {
    return false;
  }
}

/** Verify a password hash. Malformed/unrecognised hashes return false. */
export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof encodedHash !== 'string') return false;
  if (encodedHash.startsWith(`${HASH_PREFIX}$`)) return verifyScryptPassword(password, encodedHash);
  if (encodedHash.startsWith(`${LEGACY_PBKDF2_PREFIX}$`)) {
    return verifyLegacyPbkdf2Password(password, encodedHash);
  }
  return false;
}

export function isPasswordHash(value: string): boolean {
  return (
    typeof value === 'string' &&
    (value.startsWith(`${HASH_PREFIX}$`) || value.startsWith(`${LEGACY_PBKDF2_PREFIX}$`))
  );
}
