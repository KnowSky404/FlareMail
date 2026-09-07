import { describe, expect, test } from 'bun:test';
import { sessionCookieNamesForRequest } from './hooks.server';
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
});
