import { describe, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT, type FetchImplementation, type JWK } from 'jose';
import { createCloudflareAccessVerifier, type CloudflareAccessConfig } from './cloudflare-access';

const now = new Date('2026-09-20T12:00:00.000Z');
const nowSeconds = Math.floor(now.getTime() / 1000);
const config: CloudflareAccessConfig = {
  issuer: 'https://flaremail-team.cloudflareaccess.com',
  audience: 'flaremail-audience',
  jwksUrl: 'https://flaremail-team.cloudflareaccess.com/cdn-cgi/access/certs',
  allowedSubject: 'owner-access-subject'
};

async function keyPair(kid: string) {
  const keys = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
  const jwk = { ...await exportJWK(keys.publicKey), kid, alg: 'RS256', use: 'sig' } as JWK;
  return { ...keys, jwk };
}

async function assertion(
  privateKey: CryptoKey,
  options: { kid?: string; iss?: string; aud?: string | string[]; sub?: string; exp?: number; nbf?: number; iat?: number; omit?: string[] } = {}
) {
  const omit = new Set(options.omit ?? []);
  const builder = new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'access-key-1', typ: 'JWT' });
  if (!omit.has('iss')) builder.setIssuer(options.iss ?? config.issuer);
  if (!omit.has('aud')) builder.setAudience(options.aud ?? config.audience);
  if (!omit.has('sub')) builder.setSubject(options.sub ?? config.allowedSubject);
  if (!omit.has('iat')) builder.setIssuedAt(options.iat ?? nowSeconds);
  if (!omit.has('nbf')) builder.setNotBefore(options.nbf ?? nowSeconds - 1);
  if (!omit.has('exp')) builder.setExpirationTime(options.exp ?? nowSeconds + 300);
  return builder.sign(privateKey);
}

function verifier(jwks: JWK[], extra: { fetcher?: FetchImplementation; cooldownDuration?: number } = {}) {
  const fetcher = extra.fetcher ?? (async () => new Response(JSON.stringify({ keys: jwks }), {
    headers: { 'content-type': 'application/json' }
  }));
  return createCloudflareAccessVerifier(config, {
    fetcher,
    cooldownDuration: extra.cooldownDuration ?? 0,
    timeoutDuration: 1_000,
    cacheMaxAge: 60_000
  });
}

describe('Cloudflare Access JWT verification', () => {
  test('accepts an allowlisted subject with a valid signature and required claims', async () => {
    const keys = await keyPair('access-key-1');
    const verify = verifier([keys.jwk]);
    expect(await verify(await assertion(keys.privateKey), now)).toEqual({
      status: 'valid', subject: config.allowedSubject, expiresAt: nowSeconds + 300
    });
  });

  test('rejects a missing assertion and invalid signature, subject, issuer or audience', async () => {
    const keys = await keyPair('access-key-1');
    const wrongKey = await keyPair('access-key-1');
    const verify = verifier([keys.jwk]);
    expect(await verify('', now)).toEqual({ status: 'invalid' });
    expect(await verify(await assertion(wrongKey.privateKey), now)).toEqual({ status: 'invalid' });
    expect(await verify(await assertion(keys.privateKey, { sub: 'another-subject' }), now)).toEqual({ status: 'invalid' });
    expect(await verify(await assertion(keys.privateKey, { iss: 'https://other.cloudflareaccess.com' }), now)).toEqual({ status: 'invalid' });
    expect(await verify(await assertion(keys.privateKey, { aud: 'another-audience' }), now)).toEqual({ status: 'invalid' });
  });

  test('rejects missing, expired and future time claims', async () => {
    const keys = await keyPair('access-key-1');
    const verify = verifier([keys.jwk]);
    expect(await verify(await assertion(keys.privateKey, { omit: ['iat'] }), now)).toEqual({ status: 'invalid' });
    expect(await verify(await assertion(keys.privateKey, { exp: nowSeconds - 1 }), now)).toEqual({ status: 'invalid' });
    expect(await verify(await assertion(keys.privateKey, { nbf: nowSeconds + 1 }), now)).toEqual({ status: 'invalid' });
    expect(await verify(await assertion(keys.privateKey, { iat: nowSeconds + 1 }), now)).toEqual({ status: 'invalid' });
  });

  test('refreshes bounded JWKS state when Cloudflare rotates to a new key id', async () => {
    const oldKey = await keyPair('access-key-1');
    const newKey = await keyPair('access-key-2');
    let fetchCount = 0;
    const fetcher: FetchImplementation = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ keys: fetchCount === 1 ? [oldKey.jwk] : [newKey.jwk] }), {
        headers: { 'content-type': 'application/json' }
      });
    };
    const verify = verifier([], { fetcher, cooldownDuration: 0 });
    expect((await verify(await assertion(oldKey.privateKey, { kid: 'access-key-1' }), now)).status).toBe('valid');
    expect((await verify(await assertion(newKey.privateKey, { kid: 'access-key-2' }), now)).status).toBe('valid');
    expect(fetchCount).toBe(2);
  });

  test('reports JWKS transport failure as unavailable and fails closed', async () => {
    const keys = await keyPair('access-key-1');
    const verify = verifier([keys.jwk], { fetcher: async () => { throw new TypeError('network unavailable'); } });
    expect(await verify(await assertion(keys.privateKey), now)).toEqual({ status: 'unavailable' });
  });
});
