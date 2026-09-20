import {
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
  type FetchImplementation,
  type RemoteJWKSet,
  type RemoteJWKSetOptions
} from 'jose';
import { parseAccessIssuer, parseAccessJwksUrl } from '$lib/server/config/env';

export interface CloudflareAccessConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  allowedSubject: string;
}

export type AccessAssertionResult =
  | { status: 'valid'; subject: string; expiresAt: number }
  | { status: 'invalid' }
  | { status: 'unavailable' };

export interface AccessJwksOptions {
  fetcher?: FetchImplementation;
  timeoutDuration?: number;
  cooldownDuration?: number;
  cacheMaxAge?: number;
}

const MAX_ASSERTION_LENGTH = 16 * 1024;
const MAX_CACHED_ISSUERS = 4;
const verifierCache = new Map<string, (assertion: string, currentDate?: Date) => Promise<AccessAssertionResult>>();

function trustedConfig(config: CloudflareAccessConfig): boolean {
  return Boolean(
    config.issuer.trim() &&
    parseAccessIssuer(config.issuer) === config.issuer &&
    config.audience.trim() && config.audience.length <= 256 && !/\s/u.test(config.audience) &&
    config.allowedSubject.trim() && config.allowedSubject.length <= 256 && !/\s/u.test(config.allowedSubject) &&
    parseAccessJwksUrl(config.jwksUrl, config.issuer) === config.jwksUrl
  );
}

function isJwksInfrastructureError(error: unknown): boolean {
  return error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid ||
    error instanceof errors.JWKSMultipleMatchingKeys ||
    error instanceof TypeError;
}

export function createCloudflareAccessVerifier(
  config: CloudflareAccessConfig,
  jwksOptions: AccessJwksOptions = {}
): (assertion: string, currentDate?: Date) => Promise<AccessAssertionResult> {
  if (!trustedConfig(config)) throw new TypeError('Cloudflare Access verification config is invalid.');

  const options: RemoteJWKSetOptions = {
    timeoutDuration: jwksOptions.timeoutDuration ?? 5_000,
    cooldownDuration: jwksOptions.cooldownDuration ?? 30_000,
    cacheMaxAge: jwksOptions.cacheMaxAge ?? 5 * 60 * 1000,
    ...(jwksOptions.fetcher ? { [customFetch]: jwksOptions.fetcher } : {})
  };
  const jwks: RemoteJWKSet = createRemoteJWKSet(new URL(config.jwksUrl), options);

  return async (assertion: string, currentDate = new Date()): Promise<AccessAssertionResult> => {
    if (typeof assertion !== 'string' || assertion.length === 0 || assertion.length > MAX_ASSERTION_LENGTH) {
      return { status: 'invalid' };
    }
    try {
      const { payload } = await jwtVerify(assertion, jwks, {
        algorithms: ['RS256'],
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ['exp', 'nbf', 'iat', 'sub'],
        clockTolerance: 5,
        currentDate
      });
      const nowSeconds = Math.floor(currentDate.getTime() / 1000);
      const expiresAt = payload.exp;
      const notBefore = payload.nbf;
      const issuedAt = payload.iat;
      const subject = payload.sub;
      if (
        typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) ||
        typeof notBefore !== 'number' || !Number.isSafeInteger(notBefore) ||
        typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) ||
        typeof subject !== 'string' || !subject || subject !== config.allowedSubject ||
        expiresAt <= nowSeconds || notBefore > nowSeconds || issuedAt > nowSeconds ||
        issuedAt > expiresAt || notBefore > expiresAt
      ) return { status: 'invalid' };
      return { status: 'valid', subject, expiresAt };
    } catch (error) {
      return { status: isJwksInfrastructureError(error) ? 'unavailable' : 'invalid' };
    }
  };
}

function getVerifier(config: CloudflareAccessConfig) {
  const key = JSON.stringify(config);
  const existing = verifierCache.get(key);
  if (existing) return existing;
  const verifier = createCloudflareAccessVerifier(config);
  verifierCache.set(key, verifier);
  if (verifierCache.size > MAX_CACHED_ISSUERS) {
    const oldest = verifierCache.keys().next().value;
    if (oldest) verifierCache.delete(oldest);
  }
  return verifier;
}

export async function verifyCloudflareAccessAssertion(
  assertion: string | null,
  config: CloudflareAccessConfig,
  currentDate?: Date
): Promise<AccessAssertionResult> {
  if (!assertion) return { status: 'invalid' };
  try {
    return await getVerifier(config)(assertion, currentDate);
  } catch {
    return { status: 'unavailable' };
  }
}
