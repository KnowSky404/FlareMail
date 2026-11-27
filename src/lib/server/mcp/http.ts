export class McpHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export function privateMcpResponse(response: Response, requestId?: string) {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  if (requestId) headers.set('x-request-id', requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function requireContentType(request: Request, type: string) {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== type ||
      (request.headers.get('content-encoding') ?? 'identity').toLowerCase() !== 'identity') {
    throw new McpHttpError(415, 'unsupported_media_type');
  }
}

export async function boundedMcpBody(request: Request, maxBytes: number, signal: AbortSignal) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) {
    throw new McpHttpError(413, 'request_too_large');
  }
  if (!request.body) throw new McpHttpError(400, 'invalid_request');
  const reader = request.body.getReader();
  const abort = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', abort, { once: true });
  const buffer = new Uint8Array(maxBytes);
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (length + value.length > maxBytes) {
        abort();
        throw new McpHttpError(413, 'request_too_large');
      }
      buffer.set(value, length);
      length += value.length;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } catch (error) {
    if (error instanceof TypeError && !signal.aborted) throw new McpHttpError(400, 'invalid_request');
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
