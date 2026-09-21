import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ClientApiError, fetchApiResponse, isAccessLoginUrl, isJsonContentType, requestJson } from './api';
import {
  clearClientAuthExpired,
  isClientAuthExpired,
  markClientAuthExpired,
  sameOriginReauthenticationPath
} from './auth-session';
import { fetchWorkspaceSession, uploadDraftAttachment } from './workspace-api';

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const xhrDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');

function installWindow() {
  const target = new EventTarget();
  Object.defineProperty(target, 'location', {
    value: { href: 'https://mail.example.test/inbox?message=email%3A1#body', origin: 'https://mail.example.test' },
    configurable: true
  });
  Object.defineProperty(globalThis, 'window', { value: target, configurable: true, writable: true });
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

type FetchStub = (input?: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function setFetch(fetcher: FetchStub) {
  Object.defineProperty(globalThis, 'fetch', { value: fetcher, configurable: true, writable: true });
}

function jsonResponse(value: unknown, status = 200, contentType = 'application/json; charset=utf-8') {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': contentType } });
}

beforeEach(() => {
  clearClientAuthExpired();
  installWindow();
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true }, configurable: true, writable: true
  });
});

afterEach(() => {
  clearClientAuthExpired();
  restoreGlobal('window', windowDescriptor);
  restoreGlobal('navigator', navigatorDescriptor);
  restoreGlobal('fetch', fetchDescriptor);
  restoreGlobal('XMLHttpRequest', xhrDescriptor);
});

describe('application API response classification', () => {
  test('adds the Access AJAX header only to same-origin API routes', async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    setFetch(async (input, init) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(null, { status: 204 });
    });

    await fetchApiResponse('/api/workspace/mailbox');
    await fetchApiResponse('https://provider.example.test/api/mailbox', {
      headers: { 'x-requested-with': 'XMLHttpRequest', 'x-provider': 'ok' }
    });

    expect(seen[0]?.headers.get('x-requested-with')).toBe('XMLHttpRequest');
    expect(seen[1]?.headers.has('x-requested-with')).toBe(false);
    expect(seen[1]?.headers.get('x-provider')).toBe('ok');
  });

  test('recognizes JSON media types with structured suffixes', () => {
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('application/problem+json')).toBe(true);
    expect(isJsonContentType('text/html')).toBe(false);
  });

  test('classifies an authenticated Worker JSON 401 as an expired session', async () => {
    setFetch(async () => jsonResponse({
      ok: false,
      error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in required.' },
      requestId: 'req-worker'
    }, 401));

    await expect(requestJson('/api/workspace/mailbox')).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_SESSION_EXPIRED'
    });
    expect(isClientAuthExpired()).toBe(true);
  });

  test('classifies an edge non-JSON 401 as an expired session before parsing JSON', async () => {
    setFetch(async () => new Response('<html>Access denied</html>', {
      status: 401,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    }));

    await expect(requestJson('/api/workspace/mailbox')).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_SESSION_EXPIRED'
    });
    expect(isClientAuthExpired()).toBe(true);
  });

  test('recognizes only a known Access login redirect, not arbitrary HTML', async () => {
    expect(isAccessLoginUrl('https://mail.example.test/cdn-cgi/access/login?token=private')).toBe(true);
    expect(isAccessLoginUrl('https://mail.example.test/login')).toBe(false);
    const response = new Response('<html>Access login</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    });
    Object.defineProperties(response, {
      redirected: { value: true },
      url: { value: 'https://mail.example.test/cdn-cgi/access/login?token=not-a-return-url' }
    });
    setFetch(async () => response);

    await expect(requestJson('/api/workspace/mailbox')).rejects.toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
    expect(isClientAuthExpired()).toBe(true);
  });

  test('keeps 403, 503, arbitrary 502 HTML, and unrelated JSON 401 outside auth recovery', async () => {
    const cases = [
      { status: 403, contentType: 'text/html', code: 'FORBIDDEN' },
      { status: 503, contentType: 'text/html', code: 'SERVICE_UNAVAILABLE' },
      { status: 502, contentType: 'text/html', code: 'UPSTREAM_RESPONSE_UNAVAILABLE' }
    ];
    for (const item of cases) {
      clearClientAuthExpired();
      setFetch(async () => new Response('<html>proxy error</html>', {
        status: item.status,
        headers: { 'content-type': item.contentType }
      }));
      await expect(requestJson('/api/workspace/mailbox')).rejects.toMatchObject({ code: item.code });
      expect(isClientAuthExpired()).toBe(false);
    }

    setFetch(async () => jsonResponse({
      ok: false,
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' },
      requestId: 'req-login'
    }, 401));
    await expect(requestJson('/api/workspace/session', { method: 'POST' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(isClientAuthExpired()).toBe(false);
  });

  test('distinguishes offline and online network failures from auth expiry', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true });
    setFetch(async () => { throw new TypeError('fetch failed'); });
    await expect(fetchApiResponse('/api/workspace/mailbox')).rejects.toMatchObject({ code: 'NETWORK_OFFLINE' });
    expect(isClientAuthExpired()).toBe(false);

    Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
    await expect(fetchApiResponse('/api/workspace/mailbox')).rejects.toMatchObject({ code: 'NETWORK_OR_CORS_ERROR' });
    expect(isClientAuthExpired()).toBe(false);
  });

  test('blocks ordinary requests after expiry but allows the explicit session GET', async () => {
    let calls = 0;
    setFetch(async () => {
      calls += 1;
      return jsonResponse({ ok: true, data: { authenticated: true, workspace: null }, requestId: 'req-session' });
    });
    markClientAuthExpired('access-edge');

    await expect(fetchApiResponse('/api/workspace/mailbox')).rejects.toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
    expect(calls).toBe(0);
    await expect(fetchWorkspaceSession({ allowAfterAuthExpiry: true })).resolves.toMatchObject({ authenticated: true });
    expect(calls).toBe(1);
  });

  test('keeps reauthentication paths same-origin and drops query and fragment data', () => {
    expect(sameOriginReauthenticationPath(
      'https://mail.example.test/messages/email%3Aone?secret=search#body',
      'https://mail.example.test'
    )).toBe('/messages/email%3Aone');
    expect(sameOriginReauthenticationPath('https://attacker.example.test/collect?secret=x', 'https://mail.example.test')).toBe('/');
    expect(sameOriginReauthenticationPath('https://mail.example.test//attacker.example.test/path', 'https://mail.example.test')).toBe('/');
  });
});

describe('attachment XHR Access handling', () => {
  test('adds the AJAX header and classifies an Access HTML 401', async () => {
    class FakeXMLHttpRequest {
      status = 401;
      response: unknown = null;
      responseURL = 'https://mail.example.test/api/workspace/drafts/d/attachments/a';
      responseType = '';
      upload: Record<string, unknown> = {};
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      headers = new Map<string, string>();
      contentType = 'text/html';
      static instance: FakeXMLHttpRequest | null = null;

      constructor() { FakeXMLHttpRequest.instance = this; }
      open() {}
      setRequestHeader(name: string, value: string) { this.headers.set(name.toLowerCase(), value); }
      getResponseHeader(name: string) { return name.toLowerCase() === 'content-type' ? this.contentType : null; }
      send() { this.onload?.(); }
      abort() { this.onabort?.(); }
    }
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      value: FakeXMLHttpRequest,
      configurable: true,
      writable: true
    });
    const file = new File(['body'], 'body.txt', { type: 'text/plain' });
    const upload = uploadDraftAttachment('draft-1', 'attachment-1', file, 0, () => undefined);

    await expect(upload.promise).rejects.toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
    expect(FakeXMLHttpRequest.instance?.headers.get('x-requested-with')).toBe('XMLHttpRequest');
    expect(isClientAuthExpired()).toBe(true);
  });
});
