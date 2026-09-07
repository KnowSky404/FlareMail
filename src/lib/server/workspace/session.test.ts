import { describe, expect, test } from 'bun:test';
import {
  getWorkspaceSessionCookieName,
  isSecureSessionRequest,
  destroyWorkspaceSession,
  secureWorkspaceSessionCookie,
  sessionCookieOptions,
  workspaceSessionCookie
} from './session';

describe('workspace session cookie policy', () => {
  test('reports revocation storage failures instead of claiming logout succeeded', async () => {
    const unavailableDb = { prepare: () => { throw new Error('D1 unavailable'); } };
    expect(await destroyWorkspaceSession({ DB: unavailableDb } as never, 'session-token')).toBe(false);
    expect(await destroyWorkspaceSession(undefined, null)).toBe(true);
  });

  test('uses a Host-prefixed secure cookie on HTTPS', () => {
    expect(isSecureSessionRequest(new URL('https://mail.example.test'))).toBe(true);
    expect(getWorkspaceSessionCookieName(true)).toBe(secureWorkspaceSessionCookie);
    expect(sessionCookieOptions(true, true)).toMatchObject({ path: '/', httpOnly: true, sameSite: 'lax', secure: true });
  });

  test('allows the non-secure cookie only for local HTTP development', () => {
    expect(isSecureSessionRequest(new URL('http://127.0.0.1:8787'))).toBe(false);
    expect(getWorkspaceSessionCookieName(false)).toBe(workspaceSessionCookie);
    expect(sessionCookieOptions(false, false).maxAge).toBeUndefined();
  });

  test('derives cookie security from each incoming request URL', () => {
    expect(isSecureSessionRequest(new URL('https://mail.example.test'))).toBe(true);
    expect(isSecureSessionRequest(new URL('https://mail-secondary.example.test'))).toBe(true);
    expect(isSecureSessionRequest(new URL('http://127.0.0.1:8787'))).toBe(false);
  });
});
