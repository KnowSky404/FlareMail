import { json, type RequestEvent } from '@sveltejs/kit';
import {
  isRuntimeErrorCode,
  unavailableState,
  type RuntimeErrorCode,
  type RuntimeUnavailableState
} from '$lib/domain/runtime-state';

export type ApiFieldErrors = Record<string, string[]>;

export interface ApiErrorBody {
  code: string;
  message: string;
  fieldErrors?: ApiFieldErrors;
  retryable?: boolean;
  details?: Record<string, string | number | boolean>;
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
  readonly retryable: boolean;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors?: ApiFieldErrors,
    readonly details?: Record<string, unknown>,
    retryable = status >= 500
  ) {
    super(message);
    this.name = 'ApiError';
    this.retryable = retryable;
  }
}

const safeRequestId = (value: string | null) =>
  value?.trim().match(/^[A-Za-z0-9._:-]{1,128}$/u)?.[0] ?? null;

export function getRequestId(event: RequestEvent): string {
  const locals = event.locals as App.Locals | undefined;
  if (locals?.requestId) return locals.requestId;
  const requestId = (
    safeRequestId(event.request.headers.get('X-Request-ID')) ??
    safeRequestId(event.request.headers.get('CF-Ray')) ??
    crypto.randomUUID()
  );
  if (locals) locals.requestId = requestId;
  return requestId;
}

const responseHeaders = (requestId: string, headers?: HeadersInit) => {
  const result = new Headers(headers);
  result.set('cache-control', 'private, no-store');
  result.set('x-request-id', requestId);
  return result;
};

function safeDetails(details?: Record<string, unknown>): Record<string, string | number | boolean> | undefined {
  if (!details) return undefined;
  const result: Record<string, string | number | boolean> = {};
  if (typeof details.reason === 'string' && /^[a-z][a-z0-9_:-]{0,63}$/u.test(details.reason)) {
    result.reason = details.reason;
  }
  if (typeof details.reviewRequired === 'boolean') result.reviewRequired = details.reviewRequired;
  if (typeof details.providerWindowHours === 'number' && Number.isInteger(details.providerWindowHours) && details.providerWindowHours >= 0 && details.providerWindowHours <= 168) {
    result.providerWindowHours = details.providerWindowHours;
  }
  if (typeof details.draftId === 'string' && /^[A-Za-z0-9._:-]{1,256}$/u.test(details.draftId)) {
    result.draftId = details.draftId;
  }
  if (typeof details.updatedAt === 'string' && details.updatedAt.length <= 64 && Number.isFinite(Date.parse(details.updatedAt))) {
    result.updatedAt = details.updatedAt;
  }
  return Object.keys(result).length ? result : undefined;
}

export function apiSuccess<T>(event: RequestEvent, data: T, init: ResponseInit = {}) {
  const requestId = getRequestId(event);
  return json(
    { ok: true, data, requestId },
    { ...init, headers: responseHeaders(requestId, init.headers) }
  );
}

export function apiFailure(event: RequestEvent, error: ApiError, init: ResponseInit = {}) {
  const requestId = getRequestId(event);
  const details = safeDetails(error.details);
  return json(
    {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
        ...(error.status >= 500 ? { retryable: error.retryable } : {}),
        ...(details ? { details } : {})
      },
      requestId
    },
    { ...init, status: error.status, headers: responseHeaders(requestId, init.headers) }
  );
}

export function classifyRuntimeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const message = error instanceof Error ? error.message : '';
  if (/no such table|no such column|schema.*migrat|migration.*schema/iu.test(message)) {
    return new ApiError(503, 'SCHEMA_NOT_READY', '服务数据结构尚未就绪。');
  }
  if (/r2|bucket|object storage/iu.test(message)) {
    return new ApiError(503, 'R2_UNAVAILABLE', '文件存储服务暂时不可用。');
  }
  if (/d1|sqlite|database|storage/iu.test(message)) {
    return new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  }
  if (/fetch|network|timeout|resend|provider/iu.test(message)) {
    return new ApiError(503, 'NETWORK_FAILURE', '外部服务暂时不可用。');
  }
  return new ApiError(500, 'INTERNAL_ERROR', '服务器暂时无法完成请求。');
}

export function runtimeUnavailableState(error: unknown, requestId: string): RuntimeUnavailableState {
  const classified = classifyRuntimeError(error);
  const code: RuntimeErrorCode = isRuntimeErrorCode(classified.code) ? classified.code : 'INTERNAL_ERROR';
  return unavailableState(code, classified.retryable, requestId);
}

export function withApiHandler(
  handler: (event: RequestEvent) => Response | Promise<Response>
) {
  return async (event: RequestEvent) => {
    try {
      return await handler(event);
    } catch (error) {
      const classified = classifyRuntimeError(error);
      const requestId = getRequestId(event);
      if (classified.status >= 500) {
        console.error(JSON.stringify({
          level: 'error',
          event: 'api_request_failed',
          requestId,
          method: event.request.method,
          path: event.url.pathname,
          code: classified.code,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        }));
      }
      return apiFailure(event, classified);
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
