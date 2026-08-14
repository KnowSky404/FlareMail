import { json, type RequestEvent } from '@sveltejs/kit';

export type ApiFieldErrors = Record<string, string[]>;

export interface ApiErrorBody {
  code: string;
  message: string;
  fieldErrors?: ApiFieldErrors;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  requestId: string;
}

export interface ApiFailure {
  ok: false;
  error: ApiErrorBody;
  requestId: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors?: ApiFieldErrors,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const safeRequestId = (value: string | null) =>
  value?.trim().match(/^[A-Za-z0-9._:-]{1,128}$/u)?.[0] ?? null;

export function getRequestId(event: RequestEvent): string {
  return (
    safeRequestId(event.request.headers.get('X-Request-ID')) ??
    safeRequestId(event.request.headers.get('CF-Ray')) ??
    crypto.randomUUID()
  );
}

const responseHeaders = (requestId: string, headers?: HeadersInit) => ({
  'cache-control': 'private, no-store',
  'x-request-id': requestId,
  ...Object.fromEntries(new Headers(headers))
});

export function apiSuccess<T>(event: RequestEvent, data: T, init: ResponseInit = {}) {
  const requestId = getRequestId(event);
  return json(
    { ok: true, data, requestId },
    { ...init, headers: responseHeaders(requestId, init.headers) }
  );
}

export function apiFailure(event: RequestEvent, error: ApiError, init: ResponseInit = {}) {
  const requestId = getRequestId(event);
  return json(
    {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
        ...(error.details ? { details: error.details } : {})
      },
      requestId
    },
    { ...init, status: error.status, headers: responseHeaders(requestId, init.headers) }
  );
}

export function withApiHandler(
  handler: (event: RequestEvent) => Response | Promise<Response>
) {
  return async (event: RequestEvent) => {
    try {
      return await handler(event);
    } catch (error) {
      if (error instanceof ApiError) return apiFailure(event, error);
      if (error instanceof Error && /no such table|no such column|schema.*migrat/iu.test(error.message)) {
        return apiFailure(event, new ApiError(503, 'SCHEMA_NOT_READY', '服务数据结构尚未就绪。'));
      }
      const requestId = getRequestId(event);
      console.error(JSON.stringify({
        level: 'error',
        event: 'api_request_failed',
        requestId,
        method: event.request.method,
        path: event.url.pathname,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      }));
      return json(
        {
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: '服务器暂时无法完成请求。' },
          requestId
        },
        { status: 500, headers: responseHeaders(requestId) }
      );
    }
  };
}

export interface JsonBodyOptions {
  maxBytes?: number;
}

const DEFAULT_JSON_BODY_LIMIT = 64 * 1024;

export async function readJsonBody<T>(event: RequestEvent, options: JsonBodyOptions = {}): Promise<T> {
  const contentType = event.request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!contentType || (contentType !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/u.test(contentType))) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求正文必须使用 JSON。');
  }
  const maxBytes = options.maxBytes ?? DEFAULT_JSON_BODY_LIMIT;
  const declared = event.request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/u.test(declared.trim())) throw new ApiError(400, 'INVALID_CONTENT_LENGTH', '请求长度无效。');
    if (Number(declared) > maxBytes) throw new ApiError(413, 'JSON_BODY_TOO_LARGE', '请求正文超过大小限制。');
  }
  try {
    if (!event.request.body) throw new Error('empty body');
    const reader = event.request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new ApiError(413, 'JSON_BODY_TOO_LARGE', '请求正文超过大小限制。');
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'INVALID_JSON', '请求正文必须是有效的 JSON。');
  }
}

export function fieldErrorsFromIssues(issues: Array<{ field: string; message: string }>): ApiFieldErrors {
  const errors: ApiFieldErrors = {};
  for (const issue of issues) (errors[issue.field] ??= []).push(issue.message);
  return errors;
}

export function requirePathParam(event: RequestEvent, name: string): string {
  const value = (event.params as Record<string, string | undefined>)[name];
  if (!value) throw new ApiError(400, 'INVALID_PATH_PARAMETER', '请求路径参数无效。');
  return value;
}
