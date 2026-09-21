export const MAIL_HEALTH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAIL_HEALTH_TRANSIENT_COLLECT_GRACE_MS = 24 * 60 * 60 * 1000;
export const TRANSIENT_CLOUDFLARE_HEALTH_ERRORS = new Set([
  'cloudflare_rate_limited',
  'cloudflare_timeout',
  'cloudflare_network_failure',
  'cloudflare_upstream_failed'
]);
const healthyCheckMinDelayMs = 16 * 60 * 60 * 1000;
const healthyCheckJitterMs = 4 * 60 * 60 * 1000;
const retryBaseDelayMs = 5 * 60 * 1000;
const maxRetryDelayMs = 20 * 60 * 60 * 1000;
const configurationRetryDelayMs = 6 * 60 * 60 * 1000;

export type MailHealthState = 'not_configured' | 'fresh' | 'stale' | 'refreshing' | 'degraded';

export function isMailHealthFresh(checkedAt: string | null | undefined, nowMs = Date.now()) {
  const checkedAtMs = checkedAt ? Date.parse(checkedAt) : Number.NaN;
  return Number.isFinite(checkedAtMs) && checkedAtMs <= nowMs && nowMs - checkedAtMs <= MAIL_HEALTH_MAX_AGE_MS;
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function mailHealthNextCheckAt(
  domainId: string,
  nowMs: number,
  failureCount: number,
  errorCode: string | null,
  retryable: boolean
) {
  let delay: number;
  if (!errorCode) {
    delay = healthyCheckMinDelayMs + stableHash(domainId) % (healthyCheckJitterMs + 1);
  } else if (!retryable) {
    delay = configurationRetryDelayMs;
  } else {
    const exponent = Math.min(Math.max(failureCount - 1, 0), 16);
    const base = Math.min(maxRetryDelayMs, retryBaseDelayMs * (2 ** exponent));
    const jitterPercent = 80 + (stableHash(domainId + ':' + failureCount) % 41);
    delay = Math.min(maxRetryDelayMs, Math.round(base * jitterPercent / 100));
  }
  return new Date(nowMs + delay).toISOString();
}

export function mailHealthState(input: {
  configured: boolean;
  checkedAt: string | null | undefined;
  leaseExpiresAt?: string | null;
  errorCode?: string | null;
  nowMs?: number;
}): MailHealthState {
  if (!input.configured) return 'not_configured';
  const nowMs = input.nowMs ?? Date.now();
  const leaseExpiresAt = input.leaseExpiresAt ? Date.parse(input.leaseExpiresAt) : Number.NaN;
  if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt > nowMs) return 'refreshing';
  if (input.errorCode) return 'degraded';
  return isMailHealthFresh(input.checkedAt, nowMs) ? 'fresh' : 'stale';
}
