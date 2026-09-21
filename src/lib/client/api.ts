import { isClientAuthExpired, markClientAuthExpired, type AuthExpirySource } from './auth-session';

export interface ClientApiErrorBody {
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
  details?: Record<string, unknown>;
}

export class ClientApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly fieldErrors?: Record<string, string[]>,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ClientApiError';
  }
}

type ModernEnvelope<T> =
  | { ok: true; data: T; requestId: string }
  | { ok: false; error: ClientApiErrorBody; requestId: string };

type LegacyEnvelope = {
  ok?: boolean;
  error?: string;
  code?: string;
  requestId?: string;
};

export interface RequestJsonPolicy {
  /** Only session recovery GETs should set this while the current tab is in a reauth-needed state. */
  allowAfterAuthExpiry?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requestTarget(url: string) {
  if (typeof window === 'undefined') return { sameOriginApi: false, originalUrl: null as URL | null };
  try {
    const originalUrl = new URL(url, window.location.href);
    return {
      originalUrl,
      sameOriginApi: originalUrl.origin === window.location.origin &&
        (originalUrl.pathname === '/api' || originalUrl.pathname.startsWith('/api/'))
    };
  } catch {
    return { sameOriginApi: false, originalUrl: null as URL | null };
  }
}

export function isJsonContentType(value: string | null) {
  return Boolean(value && /\bjson\b/iu.test(value));
}

export function isHtmlContentType(value: string | null) {
  return Boolean(value && /(?:text\/html|application\/xhtml\+xml)/iu.test(value));
}

export function isAccessLoginUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value, typeof window === 'undefined' ? 'https://flaremail.invalid' : window.location.origin);
    return /(?:^|\/)cdn-cgi\/access\/login(?:\/|$)/iu.test(url.pathname) ||
      (url.hostname.toLowerCase().endsWith('.cloudflareaccess.com') && /\/access\/login(?:\/|$)/iu.test(url.pathname));
  } catch {
    return false;
  }
}

function errorCodeFromPayload(value: unknown) {
  if (!isRecord(value)) return null;
  const error = value.error;
  if (isRecord(error) && typeof error.code === 'string') return error.code;
  return typeof value.code === 'string' ? value.code : null;
}

function authenticationError(status = 401) {
  return new ClientApiError(status, 'AUTH_SESSION_EXPIRED', '登录状态已失效。当前编辑内容仍保留；请重新认证后手动继续。');
}

export function requestNetworkError(error?: unknown) {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') return error;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return new ClientApiError(
    0,
    offline ? 'NETWORK_OFFLINE' : 'NETWORK_OR_CORS_ERROR',
    offline
      ? '设备当前离线，请恢复网络后重试。'
      : '请求未能到达服务；网络或浏览器跨域策略可能阻止了连接，这不表示登录已过期。'
  );
}

function responseError(response: Response) {
  const code = response.status === 403
    ? 'FORBIDDEN'
    : response.status === 502
      ? 'UPSTREAM_RESPONSE_UNAVAILABLE'
      : response.status === 503
        ? 'SERVICE_UNAVAILABLE'
        : 'INVALID_RESPONSE';
  const message = response.status === 403
    ? '当前账号无权执行此操作。'
    : response.status >= 500
      ? '服务暂时无法完成请求，请稍后重试。'
      : '服务器返回了无法解析的响应。';
  return new ClientApiError(response.status, code, message, response.headers.get('x-request-id') ?? undefined);
}

/** Fetch an application resource with Access AJAX signaling and strict origin scoping. */
export async function fetchApiResponse(
  url: string,
  init: RequestInit = {},
  policy: RequestJsonPolicy = {}
): Promise<Response> {
  if (isClientAuthExpired() && !policy.allowAfterAuthExpiry) throw authenticationError();

  const target = requestTarget(url);
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (target.sameOriginApi) headers.set('x-requested-with', 'XMLHttpRequest');
  else headers.delete('x-requested-with');

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (error) {
    throw requestNetworkError(error);
  }

  if (target.sameOriginApi) {
    if (response.redirected && isHtmlContentType(response.headers.get('content-type')) && isAccessLoginUrl(response.url)) {
      markClientAuthExpired('access-login-redirect');
      throw authenticationError(response.status || 401);
    }
    if (response.status === 401 && !isJsonContentType(response.headers.get('content-type'))) {
      markClientAuthExpired('access-edge');
      throw authenticationError(response.status);
    }
    if (response.status === 401 && isJsonContentType(response.headers.get('content-type'))) {
      const payload: unknown = await response.clone().json().catch(() => null);
      if (['ACCESS_REQUIRED', 'AUTHENTICATION_REQUIRED'].includes(errorCodeFromPayload(payload) ?? '')) {
        markClientAuthExpired('worker-session');
        throw authenticationError(response.status);
      }
    }
  }

  return response;
}

export async function requestJson<T>(url: string, init: RequestInit = {}, policy: RequestJsonPolicy = {}): Promise<T> {
  const response = await fetchApiResponse(url, init, policy);
  if (!isJsonContentType(response.headers.get('content-type'))) throw responseError(response);

  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    throw new ClientApiError(
      response.status,
      'INVALID_RESPONSE',
      '服务器返回了无法解析的响应。',
      response.headers.get('x-request-id') ?? undefined
    );
  }

  if (!isRecord(payload)) throw responseError(response);
  const envelope = payload as ModernEnvelope<T> | (T & LegacyEnvelope);

  if (!response.ok || envelope.ok === false) {
    const rawError = 'error' in envelope ? envelope.error : undefined;
    const modernError = typeof rawError === 'object' && rawError
      ? rawError as ClientApiErrorBody
      : null;
    const code = modernError?.code ?? ('code' in envelope && typeof envelope.code === 'string' ? envelope.code : 'REQUEST_FAILED');
    if (response.status === 401 && ['ACCESS_REQUIRED', 'AUTHENTICATION_REQUIRED'].includes(code)) {
      markClientAuthExpired('worker-session');
      throw authenticationError(response.status);
    }
    throw new ClientApiError(
      response.status,
      code,
      modernError?.message ?? (typeof rawError === 'string' ? rawError : '请求失败。'),
      'requestId' in envelope && typeof envelope.requestId === 'string' ? envelope.requestId : response.headers.get('x-request-id') ?? undefined,
      modernError?.fieldErrors,
      modernError?.details
    );
  }

  return 'data' in envelope ? envelope.data : envelope as T;
}
