import { describe, expect, test } from 'bun:test';
import {
  getWorkspaceSessionCookieName,
  isSecureSessionRequest,
  secureWorkspaceSessionCookie,
  sessionCookieOptions,
  workspaceSessionCookie
} from './session';

describe('workspace session cookie policy', () => {
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

  test('treats the configured public origin as authoritative', () => {
    expect(isSecureSessionRequest(new URL('http://127.0.0.1:8787'), {
      APP_ORIGIN: 'https://mail.example.test'
    } as never)).toBe(true);
  });
});
