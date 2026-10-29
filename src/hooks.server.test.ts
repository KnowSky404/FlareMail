import { describe, expect, test } from 'bun:test';
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
