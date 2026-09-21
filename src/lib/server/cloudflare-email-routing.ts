const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com/client/v4';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RULE_PAGES = 100;

export type CloudflareEmailRoutingErrorCode =
  | 'token_missing'
  | 'permission_denied'
  | 'rate_limited'
  | 'timeout'
  | 'network_failure'
  | 'not_found'
  | 'invalid_response'
  | 'upstream_failed'
  | 'too_many_rules';

export class CloudflareEmailRoutingError extends Error {
  constructor(
    readonly code: CloudflareEmailRoutingErrorCode,
    readonly httpStatus: number | null = null
  ) {
    super(code);
    this.name = 'CloudflareEmailRoutingError';
  }

  get retryable() {
    return ['rate_limited', 'timeout', 'network_failure', 'upstream_failed'].includes(this.code);
  }
}

export interface CloudflareEmailRoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  source: 'api' | 'wrangler' | null;
  matchers: Array<{ type: string; field: string | null; value: string | null }>;
  actions: Array<{ type: string; value: string[] }>;
}

export interface ManagedWorkerRuleIdentity {
  addressId: string;
  email: string;
  workerName: string;
  ruleId?: string | null;
}

export interface CloudflareZoneInfo {
  id: string;
  name: string;
  accountId: string | null;
}

export interface CloudflareCatchAll {
  enabled: boolean;
  actions: Array<{ type: string; value: string[] }>;
}

type CloudflareFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ClientOptions {
  token: string;
  fetcher?: CloudflareFetcher;
  timeoutMs?: number;
  maxRulePages?: number;
  deadlineAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseRule(value: unknown): CloudflareEmailRoutingRule | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || value.id.length > 32) return null;
  const matchers = Array.isArray(value.matchers) ? value.matchers.flatMap((matcher) => {
    if (!isRecord(matcher) || typeof matcher.type !== 'string') return [];
    return [{
      type: matcher.type,
      field: typeof matcher.field === 'string' ? matcher.field : null,
      value: typeof matcher.value === 'string' ? matcher.value : null
    }];
  }) : [];
  const actions = Array.isArray(value.actions) ? value.actions.flatMap((action) => {
    if (!isRecord(action) || typeof action.type !== 'string') return [];
    return [{
      type: action.type,
      value: Array.isArray(action.value) ? action.value.filter((item): item is string => typeof item === 'string') : []
    }];
  }) : [];
  return {
    id: value.id,
    name: typeof value.name === 'string' ? value.name : '',
    enabled: value.enabled === true,
    source: value.source === 'api' || value.source === 'wrangler' ? value.source : null,
    matchers,
    actions
  };
}

function parseApiEnvelope(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || value.success !== true) throw new CloudflareEmailRoutingError('upstream_failed');
  return value;
}

function resultOf(value: unknown) {
  return parseApiEnvelope(value).result;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new CloudflareEmailRoutingError('invalid_response', response.status);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CloudflareEmailRoutingError('invalid_response', response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function isExactWorkerEmailRule(
  rule: CloudflareEmailRoutingRule,
  email: string,
  workerName: string
): boolean {
  return rule.enabled &&
    rule.matchers.length === 1 &&
    rule.matchers[0]?.type === 'literal' &&
    rule.matchers[0]?.field === 'to' &&
    rule.matchers[0]?.value?.toLowerCase() === email.toLowerCase() &&
    rule.actions.length === 1 &&
    rule.actions[0]?.type === 'worker' &&
    rule.actions[0]?.value.length === 1 &&
    rule.actions[0]?.value[0] === workerName;
}

/**
 * The stable FlareMail ownership fingerprint for rules created by this app.
 * A display name by itself is never sufficient to claim a Cloudflare rule.
 */
export function isFlareMailManagedWorkerRule(
  rule: CloudflareEmailRoutingRule,
  identity: ManagedWorkerRuleIdentity
): boolean {
  return rule.source === 'api' &&
    rule.name === 'FlareMail managed address ' + identity.addressId &&
    (identity.ruleId == null || rule.id === identity.ruleId) &&
    isExactWorkerEmailRule(rule, identity.email, identity.workerName);
}

export function isExactRecipientRule(rule: CloudflareEmailRoutingRule, email: string): boolean {
  return rule.matchers.length === 1 &&
    rule.matchers[0]?.type === 'literal' &&
    rule.matchers[0]?.field === 'to' &&
    rule.matchers[0]?.value?.toLowerCase() === email.toLowerCase();
}

export class CloudflareEmailRoutingClient {
  private readonly fetcher: CloudflareFetcher;
  private readonly timeoutMs: number;
  private readonly maxRulePages: number;
  private readonly deadlineAt: number | null;

  constructor(private readonly options: ClientOptions) {
    if (!options.token.trim()) throw new CloudflareEmailRoutingError('token_missing');
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRulePages = Math.max(1, Math.min(MAX_RULE_PAGES, options.maxRulePages ?? MAX_RULE_PAGES));
    this.deadlineAt = options.deadlineAt ?? null;
  }

  private async request(path: string, method = 'GET', body?: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timeRemaining = this.deadlineAt === null ? this.timeoutMs : Math.min(this.timeoutMs, this.deadlineAt - Date.now());
    if (timeRemaining <= 0) throw new CloudflareEmailRoutingError('timeout');
    const timeout = setTimeout(() => controller.abort(), timeRemaining);
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(CLOUDFLARE_API_ORIGIN + path, {
        method,
        headers: {
          authorization: 'Bearer ' + this.options.token,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal
      });
      text = await readBoundedResponse(response);
    } catch (error) {
      if (error instanceof CloudflareEmailRoutingError) throw error;
      const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
      throw new CloudflareEmailRoutingError(name === 'AbortError' ? 'timeout' : 'network_failure');
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401 || response.status === 403) {
      throw new CloudflareEmailRoutingError('permission_denied', response.status);
    }
    if (response.status === 404) throw new CloudflareEmailRoutingError('not_found', response.status);
    if (response.status === 429) throw new CloudflareEmailRoutingError('rate_limited', response.status);
    if (!response.ok) {
      throw new CloudflareEmailRoutingError(response.status >= 500 ? 'upstream_failed' : 'invalid_response', response.status);
    }
    if (method === 'DELETE' && !text.trim()) return { success: true, result: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CloudflareEmailRoutingError('invalid_response', response.status);
    }
    return parseApiEnvelope(parsed);
  }

  async getZone(zoneId: string): Promise<CloudflareZoneInfo> {
    const result = resultOf(await this.request('/zones/' + encodeURIComponent(zoneId)));
    if (!isRecord(result) || typeof result.id !== 'string' || typeof result.name !== 'string') {
      throw new CloudflareEmailRoutingError('invalid_response');
    }
    const accountId = isRecord(result.account) && typeof result.account.id === 'string' ? result.account.id : null;
    return { id: result.id, name: result.name, accountId };
  }

  async listRules(zoneId: string): Promise<CloudflareEmailRoutingRule[]> {
    const rules: CloudflareEmailRoutingRule[] = [];
    let page = 1;
    let pages: number | null = null;
    while (true) {
      if (page > this.maxRulePages) throw new CloudflareEmailRoutingError('too_many_rules');
      const suffix = '?page=' + page + '&per_page=100';
      const envelope = await this.request('/zones/' + encodeURIComponent(zoneId) + '/email/routing/rules' + suffix);
      const record = parseApiEnvelope(envelope);
      const result = record.result;
      if (!Array.isArray(result)) throw new CloudflareEmailRoutingError('invalid_response');
      for (const row of result) {
        const rule = parseRule(row);
        if (!rule) throw new CloudflareEmailRoutingError('invalid_response');
        rules.push(rule);
      }
      const resultInfo = record.result_info;
      if (isRecord(resultInfo) && typeof resultInfo.total_pages === 'number' && Number.isInteger(resultInfo.total_pages)) {
        pages = resultInfo.total_pages;
      }
      if (pages !== null ? page >= pages : result.length < 100) break;
      page += 1;
    }
    return rules;
  }

  async getCatchAll(zoneId: string): Promise<CloudflareCatchAll> {
    const result = resultOf(await this.request('/zones/' + encodeURIComponent(zoneId) + '/email/routing/rules/catch_all'));
    if (!isRecord(result)) throw new CloudflareEmailRoutingError('invalid_response');
    const actions = Array.isArray(result.actions) ? result.actions.flatMap((action) => {
      if (!isRecord(action) || typeof action.type !== 'string') return [];
      return [{
        type: action.type,
        value: Array.isArray(action.value) ? action.value.filter((item): item is string => typeof item === 'string') : []
      }];
    }) : [];
    const enabled = result.enabled === true;
    if (actions.length > 1 || (enabled && actions.length !== 1)) {
      throw new CloudflareEmailRoutingError('invalid_response');
    }
    return { enabled, actions };
  }

  async createWorkerRule(zoneId: string, input: { email: string; workerName: string; addressId: string }) {
    const envelope = await this.request('/zones/' + encodeURIComponent(zoneId) + '/email/routing/rules', 'POST', {
      actions: [{ type: 'worker', value: [input.workerName] }],
      matchers: [{ type: 'literal', field: 'to', value: input.email }],
      enabled: true,
      name: 'FlareMail managed address ' + input.addressId,
      source: 'api'
    });
    const rule = parseRule(resultOf(envelope));
    if (!rule) throw new CloudflareEmailRoutingError('invalid_response');
    return rule;
  }

  async deleteRule(zoneId: string, ruleId: string) {
    await this.request(
      '/zones/' + encodeURIComponent(zoneId) + '/email/routing/rules/' + encodeURIComponent(ruleId),
      'DELETE'
    );
  }
}
