import { describe, expect, mock, spyOn, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { hashSessionToken } from '$lib/server/auth/token';
import { FLAREMAIL_SCHEMA_VERSION } from '$lib/server/db/schema-version';
import { handleError, handle, isAccessExemptPath, isPrivateReaderPath, sessionCookieNamesForRequest } from './hooks.server';
import { legacyWorkspaceSessionCookie, secureWorkspaceSessionCookie, workspaceSessionCookie } from '$lib/server/workspace';

describe('request session cookie policy', () => {
  test('accepts only the Host cookie for HTTPS requests', () => {
    expect(sessionCookieNamesForRequest(new URL('https://mail.example.test')))
      .toEqual([secureWorkspaceSessionCookie]);
  });

  test('accepts legacy cookies only on local HTTP requests', () => {
    expect(sessionCookieNamesForRequest(new URL('http://127.0.0.1:8787')))
      .toEqual([workspaceSessionCookie, legacyWorkspaceSessionCookie]);
  });

  test('marks standalone message documents as private reader routes', () => {
    expect(isPrivateReaderPath('/messages/inbound-1')).toBe(true);
    expect(isPrivateReaderPath('/api/workspace/messages/inbound-1')).toBe(false);
    expect(isPrivateReaderPath('/')).toBe(false);
  });

  test('requires an Access assertion even when a legacy local cookie is present', async () => {
    let resolved = false;
    const response = await handle({
      event: {
        request: new Request('https://mail.example.test/messages/private-id'),
        url: new URL('https://mail.example.test/messages/private-id'),
        platform: { env: {
          AUTH_MODE: 'cloudflare-access',
          ACCESS_ISSUER: 'https://flaremail-team.cloudflareaccess.com',
          ACCESS_AUDIENCE: 'audience',
          ACCESS_JWKS_URL: 'https://flaremail-team.cloudflareaccess.com/cdn-cgi/access/certs',
          ACCESS_ALLOWED_SUBJECT: 'owner-subject',
          ACCESS_OWNER_USER_ID: 'owner-1'
        } },
        locals: {},
        cookies: { get: () => 'old-local-session' }
      } as never,
      resolve: async () => {
        resolved = true;
        return new Response('private');
      }
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(resolved).toBe(false);
  });

  test('reuses a verified Access session and refuses a changed Owner mapping before issuing a cookie', async () => {
    using database = new Database(':memory:');
    database.exec(await Bun.file(new URL('../schema.sql', import.meta.url)).text());
    database.exec(`
      INSERT INTO workspace_users (id, name, role) VALUES ('owner', 'Owner', 'Owner'), ('other', 'Other', 'Owner');
      INSERT INTO workspace_owner (singleton, user_id) VALUES (1, 'owner');
    `);
    const cookieToken = 'synthetic-access-cookie';
    const now = Math.floor(Date.now() / 1000);
    database.query(`INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
      VALUES ('flaremail', ?, ?)`).run(FLAREMAIL_SCHEMA_VERSION, new Date(now * 1000).toISOString());
    database.query(`
      INSERT INTO workspace_sessions (id, user_id, token_hash, expires_at, last_seen_at, auth_method, principal_id)
      VALUES ('existing-session', 'owner', ?, ?, ?, 'cloudflare-access', 'owner-subject')
    `).run(await hashSessionToken(cookieToken), new Date((now + 600) * 1000).toISOString(), new Date(now * 1000).toISOString());
    const issuer = `https://hook-${crypto.randomUUID()}.cloudflareaccess.com`;
    const certs = issuer + '/cdn-cgi/access/certs';
    const keys = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'hook-test-key', alg: 'RS256' };
    const assertion = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
      .setIssuer(issuer).setAudience('hook-audience').setSubject('owner-subject')
      .setIssuedAt(now).setNotBefore(now - 1).setExpirationTime(now + 300).sign(keys.privateKey);
    const syntheticJwks = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input) !== certs) throw new Error('Unexpected network request in the hook test.');
      return Response.json({ keys: [jwk] });
    }, { preconnect: fetch.preconnect });
    const fetchJwks = spyOn(globalThis, 'fetch').mockImplementation(syntheticJwks);
    const statements: string[] = [];
    const env = {
      APP_ENV: 'test', OUTBOUND_PROVIDER: 'demo', ALLOW_FAKE_SERVICES: 'true',
      AUTH_MODE: 'cloudflare-access', ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: 'hook-audience',
      ACCESS_JWKS_URL: certs, ACCESS_ALLOWED_SUBJECT: 'owner-subject', ACCESS_OWNER_USER_ID: 'owner',
      DB: { prepare(sql: string) {
        statements.push(sql);
        const statement = database.query(sql);
        const bind = (...args: SQLQueryBindings[]) => ({
          first: async () => statement.get(...args), run: async () => statement.run(...args)
        });
        return { ...bind(), bind };
      } }
    };
    const url = new URL('https://mail.example.test/api/workspace/mailbox');
    const setCookie = mock();
    const resolve = mock(async () => new Response('resolved'));
    const request = () => ({
      request: new Request(url, { headers: { 'Cf-Access-Jwt-Assertion': assertion } }),
      url, platform: { env }, locals: {} as App.Locals,
      cookies: { get: (name: string) => name === secureWorkspaceSessionCookie ? cookieToken : undefined, set: setCookie, delete: mock() }
    });
    try {
      const matched = request();
      const accepted = await handle({ event: matched as never, resolve });
      expect(accepted.status, await accepted.text()).toBe(200);
      expect(matched.locals.workspaceSession).toMatchObject({ id: 'existing-session', userId: 'owner' });
      expect(fetchJwks).toHaveBeenCalledTimes(1);
      expect(statements).toHaveLength(2);
      expect(resolve).toHaveBeenCalledTimes(1);

      database.exec("UPDATE workspace_owner SET user_id = 'other' WHERE singleton = 1");
      const mismatch = await handle({ event: request() as never, resolve });
      expect(mismatch.status).toBe(503);
      expect(await mismatch.json()).toMatchObject({ error: { code: 'OWNER_MAPPING_REQUIRED' } });
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(setCookie).not.toHaveBeenCalled();
      expect(database.query('SELECT count(*) AS count FROM workspace_sessions').get()).toEqual({ count: 1 });
    } finally {
      fetchJwks.mockRestore();
    }
  });

  test('keeps only the exact health and signed webhook paths outside Access', () => {
    expect(isAccessExemptPath('/api/health')).toBe(true);
    expect(isAccessExemptPath('/api/readiness')).toBe(false);
    expect(isAccessExemptPath('/api/webhooks/resend')).toBe(true);
    expect(isAccessExemptPath('/api/webhooks/telegram')).toBe(true);
    expect(isAccessExemptPath('/api/workspace/session')).toBe(false);
    expect(isAccessExemptPath('/api/webhooks/telegram/extra')).toBe(false);
  });
});


describe('SvelteKit 3 error hooks', () => {
  test('preserves intentional application and framework error statuses and messages', async () => {
    const event = { request: new Request('https://mail.example.test/missing'), url: new URL('https://mail.example.test/missing'), locals: { requestId: 'test-error-request' } };
    expect(await handleError({ kind: 'app', error: { status: 403, message: 'Access denied' }, event } as never)).toMatchObject({ status: 403, message: 'Access denied', requestId: 'test-error-request' });
    expect(await handleError({ kind: 'framework', error: { status: 404, message: 'Not found' }, event } as never)).toMatchObject({ status: 404, message: 'Not found' });
    expect(await handleError({ kind: 'unknown', error: new Error('private server detail'), event } as never)).toMatchObject({ message: '服务器暂时无法完成请求。', requestId: 'test-error-request' });
  });
});
