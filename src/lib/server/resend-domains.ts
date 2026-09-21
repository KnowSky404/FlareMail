const RESEND_API_ORIGIN = 'https://api.resend.com';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PAGES = 20;

export class ResendDomainError extends Error {
  constructor(readonly code: 'api_key_missing' | 'permission_denied' | 'rate_limited' | 'timeout' | 'network_failure' | 'invalid_response' | 'upstream_failed') {
    super(code);
    this.name = 'ResendDomainError';
  }
}

export interface ResendDomainStatus {
  id: string;
  name: string;
  verified: boolean;
  status: string;
  sendingEnabled: boolean | null;
}

interface FetchOptions {
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  deadlineAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function requestJson(apiKey: string, path: string, options: FetchOptions): Promise<unknown> {
  const controller = new AbortController();
  const requestTimeoutMs = options.deadlineAt === undefined
    ? (options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    : Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.deadlineAt - Date.now());
  if (requestTimeoutMs <= 0) throw new ResendDomainError('timeout');
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    let response: Response;
    try {
      response = await (options.fetcher ?? fetch)(RESEND_API_ORIGIN + path, {
        method: 'GET',
        headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' },
        signal: controller.signal
      });
    } catch (error) {
      const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
      throw new ResendDomainError(name === 'AbortError' ? 'timeout' : 'network_failure');
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ResendDomainError('invalid_response');
    }
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new ResendDomainError('invalid_response');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ResendDomainError('invalid_response');
    }
    if (response.status === 401 || response.status === 403) throw new ResendDomainError('permission_denied');
    if (response.status === 429) throw new ResendDomainError('rate_limited');
    if (!response.ok) throw new ResendDomainError(response.status >= 500 ? 'upstream_failed' : 'invalid_response');
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

function parseDomain(value: unknown): ResendDomainStatus | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.status !== 'string') {
    return null;
  }
  const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
  const sendingEnabled = capabilities.sending === 'enabled'
    ? true
    : capabilities.sending === 'disabled' ? false : null;
  return {
    id: value.id,
    name: value.name,
    status: value.status,
    verified: value.status === 'verified',
    sendingEnabled
  };
}

export async function getExactResendDomain(
  apiKey: string,
  exactDomainName: string,
  options: FetchOptions = {}
): Promise<ResendDomainStatus | null> {
  if (!apiKey.trim()) throw new ResendDomainError('api_key_missing');
  const domainName = exactDomainName.trim().toLowerCase();
  if (!domainName) throw new ResendDomainError('invalid_response');
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: '100' });
    if (after) query.set('after', after);
    const payload = await requestJson(apiKey, '/domains?' + query.toString(), options);
    if (!isRecord(payload) || !Array.isArray(payload.data) || typeof payload.has_more !== 'boolean') {
      throw new ResendDomainError('invalid_response');
    }
    const domains = payload.data.map(parseDomain);
    if (domains.some((domain) => domain === null)) throw new ResendDomainError('invalid_response');
    const exact = (domains as ResendDomainStatus[]).find((domain) => domain.name.toLowerCase() === domainName);
    if (exact) return exact;
    if (!payload.has_more) return null;
    after = (domains as ResendDomainStatus[]).at(-1)?.id ?? null;
    if (!after) throw new ResendDomainError('invalid_response');
  }
  throw new ResendDomainError('invalid_response');
}

export function canSendFromResendDomain(domain: ResendDomainStatus | null, exactDomainName: string) {
  return Boolean(
    domain &&
    domain.name.toLowerCase() === exactDomainName.trim().toLowerCase() &&
    domain.verified &&
    domain.sendingEnabled === true
  );
}
