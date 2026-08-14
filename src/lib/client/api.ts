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

export async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {})
    }
  });
  let payload: ModernEnvelope<T> | (T & LegacyEnvelope);
  try {
    payload = await response.json() as ModernEnvelope<T> | (T & LegacyEnvelope);
  } catch {
    throw new ClientApiError(
      response.status,
      'INVALID_RESPONSE',
      '服务器返回了无法解析的响应。',
      response.headers.get('x-request-id') ?? undefined
    );
  }

  if (!response.ok || payload.ok === false) {
    const rawError = 'error' in payload ? payload.error : undefined;
    const modernError = typeof rawError === 'object' && rawError
      ? rawError as ClientApiErrorBody
      : null;
    throw new ClientApiError(
      response.status,
      modernError?.code ?? ('code' in payload && typeof payload.code === 'string' ? payload.code : 'REQUEST_FAILED'),
      modernError?.message ?? (typeof rawError === 'string' ? rawError : '请求失败。'),
      'requestId' in payload && typeof payload.requestId === 'string' ? payload.requestId : response.headers.get('x-request-id') ?? undefined,
      modernError?.fieldErrors,
      modernError?.details
    );
  }

  return 'data' in payload ? payload.data : payload as T;
}
