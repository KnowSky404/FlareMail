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
    readonly fieldErrors?: ApiFieldErrors
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
        ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {})
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

export async function readJsonBody<T>(event: RequestEvent): Promise<T> {
  try {
    return await event.request.json() as T;
  } catch {
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
