import { isFlareMailManagedWorkerRule, isExactRecipientRule, CloudflareEmailRoutingClient, CloudflareEmailRoutingError, type CloudflareCatchAll, type CloudflareEmailRoutingRule } from '$lib/server/cloudflare-email-routing';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { mailHealthNextCheckAt } from '$lib/domain/mail/health';
import { normalizeMailDomain } from './validation';
import { canSendFromResendDomain, getExactResendDomain, ResendDomainError, type ResendDomainStatus } from '$lib/server/resend-domains';

const providerLeaseMs = 90 * 1000;
const maxDomainsPerProvider = 1;
const candidateReadLimit = 10;

type CatchAllTarget = 'unknown' | 'this_worker' | 'external' | 'drop' | 'none';
type ProviderName = 'cloudflare' | 'resend';

interface HealthDomainRow {
  id: string;
  owner_user_id: string;
  domain_name: string;
  cloudflare_zone_id: string;
  cloudflare_account_id: string | null;
  worker_name: string;
  unknown_recipient_policy: 'reject' | 'collect';
  cloudflare_next_check_at: string | null;
  cloudflare_check_token: string | null;
  cloudflare_check_expires_at: string | null;
  cloudflare_failure_count: number;
  resend_next_check_at: string | null;
  resend_check_token: string | null;
  resend_check_expires_at: string | null;
  resend_failure_count: number;
}

interface CloudflareHealthClient {
  getZone(zoneId: string): ReturnType<CloudflareEmailRoutingClient['getZone']>;
  listRules(zoneId: string): ReturnType<CloudflareEmailRoutingClient['listRules']>;
  getCatchAll(zoneId: string): ReturnType<CloudflareEmailRoutingClient['getCatchAll']>;
}

interface ProviderCheckResult {
  errorCode: string | null;
  retryable: boolean;
  observedAt: string | null;
  catchAllTarget?: CatchAllTarget;
  catchAllObservedAt?: string;
  resend?: {
    id: string | null;
    status: 'pending' | 'verified' | 'failed';
    sendingStatus: 'unknown' | 'enabled' | 'disabled';
  };
}

export interface MailHealthRefreshDependencies {
  nowMs?: () => number;
  randomUUID?: () => string;
  maxDomainsPerProvider?: number;
  cloudflareClientFactory?: (token: string, startedAt: number) => CloudflareHealthClient;
  resendLookup?: (apiKey: string, domainName: string, options?: { timeoutMs?: number; deadlineAt?: number }) => Promise<ResendDomainStatus | null>;
}

export interface ProviderRefreshSummary {
  state: 'completed' | 'not_configured' | 'unavailable';
  checked: number;
  skippedBusy: number;
  errorCode: string | null;
}

export interface MailHealthRefreshSummary {
  cloudflare: ProviderRefreshSummary;
  resend: ProviderRefreshSummary;
}

function isoAt(milliseconds: number) {
  return new Date(milliseconds).toISOString();
}

function catchAllTarget(catchAll: CloudflareCatchAll, workerName: string): CatchAllTarget {
  if (!catchAll.enabled) return 'none';
  const action = catchAll.actions[0];
  if (!action) return 'unknown';
  if (action.type === 'drop') return 'drop';
  if (action.type === 'worker' && action.value.length === 1 && action.value[0] === workerName) return 'this_worker';
  return 'external';
}

function classifyCloudflareError(error: unknown) {
  if (error instanceof CloudflareEmailRoutingError) {
    const retryable = ['rate_limited', 'timeout', 'network_failure', 'upstream_failed'].includes(error.code);
    return { errorCode: 'cloudflare_' + error.code, retryable };
  }
  return { errorCode: 'cloudflare_check_failed', retryable: true };
}

function classifyResendError(error: unknown) {
  if (error instanceof ResendDomainError) {
    const retryable = ['rate_limited', 'timeout', 'network_failure', 'upstream_failed'].includes(error.code);
    return { errorCode: 'resend_' + error.code, retryable };
  }
  return { errorCode: 'resend_check_failed', retryable: true };
}

function validateZone(domain: HealthDomainRow, zone: { id: string; name: string; accountId: string | null }) {
  let zoneName: string;
  try {
    zoneName = normalizeMailDomain(zone.name);
  } catch {
    return false;
  }
  const domainMatchesZone = domain.domain_name === zoneName || domain.domain_name.endsWith('.' + zoneName);
  const accountMatches = !domain.cloudflare_account_id || !zone.accountId || domain.cloudflare_account_id === zone.accountId;
  return zone.id === domain.cloudflare_zone_id && domainMatchesZone && accountMatches;
}

async function checkManagedRouteDrift(
  db: D1Database,
  domain: HealthDomainRow,
  rules: CloudflareEmailRoutingRule[]
) {
  const addresses = await db.prepare(
    `SELECT id, email, routing_rule_id FROM mail_addresses
     WHERE owner_user_id = ? AND domain_id = ? AND lifecycle_status <> 'deleted' AND routing_owner = 'flaremail'`
  ).bind(domain.owner_user_id, domain.id).all<{ id: string; email: string; routing_rule_id: string | null }>();

  return (addresses.results ?? []).some((address) => {
    const matches = rules.filter((rule) => isExactRecipientRule(rule, address.email));
    return matches.length !== 1 || !isFlareMailManagedWorkerRule(matches[0]!, {
      addressId: address.id,
      email: address.email,
      workerName: domain.worker_name,
      ruleId: address.routing_rule_id
    });
  });
}

async function checkCloudflareDomain(
  db: D1Database,
  domain: HealthDomainRow,
  client: CloudflareHealthClient,
  nowMs: number
): Promise<ProviderCheckResult> {
  const observations = await Promise.allSettled([
    client.getZone(domain.cloudflare_zone_id),
    client.getCatchAll(domain.cloudflare_zone_id)
  ]);
  const rejected = observations.find((result) => result.status === 'rejected');
  if (rejected?.status === 'rejected') {
    return { ...classifyCloudflareError(rejected.reason), observedAt: null };
  }
  const zone = (observations[0] as PromiseFulfilledResult<Awaited<ReturnType<CloudflareHealthClient['getZone']>>>).value;
  const catchAll = (observations[1] as PromiseFulfilledResult<CloudflareCatchAll>).value;
  if (!validateZone(domain, zone)) {
    return { errorCode: 'cloudflare_zone_mapping_conflict', retryable: false, observedAt: null };
  }

  const target = catchAllTarget(catchAll, domain.worker_name);
  const catchAllObservedAt = isoAt(nowMs);
  try {
    const rules = await client.listRules(domain.cloudflare_zone_id);
    const routeDrift = await checkManagedRouteDrift(db, domain, rules);
    const collectMismatch = domain.unknown_recipient_policy === 'collect' && target !== 'this_worker';
    return {
      errorCode: collectMismatch ? 'cloudflare_collect_catch_all_unavailable' : routeDrift ? 'cloudflare_managed_route_needs_review' : null,
      retryable: false,
      observedAt: isoAt(nowMs),
      catchAllTarget: target,
      catchAllObservedAt
    };
  } catch (error) {
    return {
      ...classifyCloudflareError(error),
      observedAt: null,
      catchAllTarget: target,
      catchAllObservedAt
    };
  }
}

async function checkResendDomain(
  domain: HealthDomainRow,
  apiKey: string,
  lookup: NonNullable<MailHealthRefreshDependencies['resendLookup']>,
  nowMs: number
): Promise<ProviderCheckResult> {
  try {
    const result = await lookup(apiKey, domain.domain_name, { timeoutMs: 4_000, deadlineAt: nowMs + 10_000 });
    const ready = canSendFromResendDomain(result, domain.domain_name);
    const status = result?.status === 'failed' ? 'failed' : ready ? 'verified' : 'pending';
    const sendingStatus = result?.sendingEnabled === true ? 'enabled' : result?.sendingEnabled === false ? 'disabled' : 'unknown';
    const errorCode = !result ? 'resend_domain_missing' : status === 'failed' ? 'resend_domain_failed' :
      status !== 'verified' ? 'resend_domain_not_verified' : sendingStatus !== 'enabled' ? 'resend_sending_disabled' : null;
    return {
      errorCode,
      retryable: false,
      observedAt: isoAt(nowMs),
      resend: { id: result?.id ?? null, status, sendingStatus }
    };
  } catch (error) {
    return { ...classifyResendError(error), observedAt: null };
  }
}

function selectCandidates(db: D1Database, provider: ProviderName, now: string) {
  const stem = provider === 'cloudflare' ? 'cloudflare' : 'resend';
  return db.prepare(
    `SELECT id, owner_user_id, domain_name, cloudflare_zone_id, cloudflare_account_id, worker_name,
            unknown_recipient_policy, cloudflare_next_check_at, cloudflare_check_token, cloudflare_check_expires_at,
            cloudflare_failure_count, resend_next_check_at, resend_check_token, resend_check_expires_at,
            resend_failure_count
     FROM mail_domains
     WHERE (${stem}_next_check_at IS NULL OR ${stem}_next_check_at <= ?)
       AND (${stem}_check_token IS NULL OR ${stem}_check_expires_at IS NULL OR ${stem}_check_expires_at <= ?)
     ORDER BY CASE WHEN ${stem}_next_check_at IS NULL THEN 0 ELSE 1 END, ${stem}_next_check_at, domain_name COLLATE NOCASE, id
     LIMIT ?`
  ).bind(now, now, candidateReadLimit).all<HealthDomainRow>();
}

async function claimDomain(db: D1Database, provider: ProviderName, domain: HealthDomainRow, token: string, startedAt: string) {
  const expiresAt = isoAt(Date.parse(startedAt) + providerLeaseMs);
  const stem = provider;
  const result = await db.prepare(
    `UPDATE mail_domains SET ${stem}_check_token = ?, ${stem}_check_expires_at = ?, updated_at = ?
     WHERE id = ? AND owner_user_id = ?
       AND (${stem}_next_check_at IS NULL OR ${stem}_next_check_at <= ?)
       AND (${stem}_check_token IS NULL OR ${stem}_check_expires_at IS NULL OR ${stem}_check_expires_at <= ?)`
  ).bind(token, expiresAt, startedAt, domain.id, domain.owner_user_id, startedAt, startedAt).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

async function saveCloudflareResult(
  db: D1Database,
  domain: HealthDomainRow,
  token: string,
  result: ProviderCheckResult,
  nowMs: number
) {
  const previousFailures = Number(domain.cloudflare_failure_count ?? 0);
  const failureCount = result.errorCode && result.retryable ? Math.min(previousFailures + 1, 1000) : 0;
  const nextAt = mailHealthNextCheckAt(domain.id, nowMs, Math.max(1, failureCount), result.errorCode, result.retryable);
  await db.prepare(
    `UPDATE mail_domains SET
       catch_all_target = CASE WHEN ? IS NULL THEN catch_all_target ELSE ? END,
       catch_all_checked_at = CASE WHEN ? IS NULL THEN catch_all_checked_at ELSE ? END,
       cloudflare_checked_at = CASE WHEN ? IS NULL THEN cloudflare_checked_at ELSE ? END,
       cloudflare_error_code = ?, cloudflare_error_at = ?, cloudflare_failure_count = ?, cloudflare_next_check_at = ?,
       cloudflare_check_token = NULL, cloudflare_check_expires_at = NULL, updated_at = ?
     WHERE id = ? AND owner_user_id = ? AND cloudflare_check_token = ?`
  ).bind(
    result.catchAllObservedAt ?? null, result.catchAllTarget ?? null,
    result.catchAllObservedAt ?? null, result.catchAllObservedAt ?? null,
    result.observedAt, result.observedAt,
    result.errorCode, result.errorCode ? isoAt(nowMs) : null, failureCount, nextAt, isoAt(nowMs),
    domain.id, domain.owner_user_id, token
  ).run();
}

async function saveResendResult(
  db: D1Database,
  domain: HealthDomainRow,
  token: string,
  result: ProviderCheckResult,
  nowMs: number
) {
  const previousFailures = Number(domain.resend_failure_count ?? 0);
  const failureCount = result.errorCode && result.retryable ? Math.min(previousFailures + 1, 1000) : 0;
  const nextAt = mailHealthNextCheckAt(domain.id, nowMs, Math.max(1, failureCount), result.errorCode, result.retryable);
  const observed = result.resend;
  await db.prepare(
    `UPDATE mail_domains SET
       resend_domain_id = CASE WHEN ? = 1 THEN ? ELSE resend_domain_id END,
       resend_status = CASE WHEN ? = 1 THEN ? ELSE resend_status END,
       resend_sending_status = CASE WHEN ? = 1 THEN ? ELSE resend_sending_status END,
       resend_checked_at = CASE WHEN ? IS NULL THEN resend_checked_at ELSE ? END,
       resend_error_code = ?, resend_error_at = ?, resend_failure_count = ?, resend_next_check_at = ?,
       resend_check_token = NULL, resend_check_expires_at = NULL, updated_at = ?
     WHERE id = ? AND owner_user_id = ? AND resend_check_token = ?`
  ).bind(
    observed ? 1 : 0, observed?.id ?? null,
    observed ? 1 : 0, observed?.status ?? null,
    observed ? 1 : 0, observed?.sendingStatus ?? null,
    result.observedAt, result.observedAt,
    result.errorCode, result.errorCode ? isoAt(nowMs) : null, failureCount, nextAt, isoAt(nowMs),
    domain.id, domain.owner_user_id, token
  ).run();
}

async function runProvider(
  env: CloudflareEnv,
  provider: ProviderName,
  credential: string | undefined,
  dependencies: MailHealthRefreshDependencies
): Promise<ProviderRefreshSummary> {
  if (!credential?.trim()) return { state: 'not_configured', checked: 0, skippedBusy: 0, errorCode: null };
  if (!env.DB) return { state: 'unavailable', checked: 0, skippedBusy: 0, errorCode: 'd1_unavailable' };
  const nowMs = dependencies.nowMs ?? Date.now;
  const uuid = dependencies.randomUUID ?? (() => crypto.randomUUID());
  const startedAt = isoAt(nowMs());
  const selected = await selectCandidates(env.DB, provider, startedAt);
  const limit = Math.max(1, Math.min(5, dependencies.maxDomainsPerProvider ?? maxDomainsPerProvider));
  let checked = 0;
  let skippedBusy = 0;

  for (const domain of selected.results ?? []) {
    if (checked >= limit) break;
    const token = uuid();
    if (!await claimDomain(env.DB, provider, domain, token, startedAt)) {
      skippedBusy += 1;
      continue;
    }
    const currentTime = nowMs();
    let result: ProviderCheckResult;
    if (provider === 'cloudflare') {
      const apiToken = credential.trim();
      const client = dependencies.cloudflareClientFactory?.(apiToken, currentTime) ??
        new CloudflareEmailRoutingClient({
          token: apiToken,
          timeoutMs: 4_000,
          maxRulePages: 10,
          deadlineAt: currentTime + 12_000
        });
      result = await checkCloudflareDomain(env.DB, domain, client, nowMs());
      await saveCloudflareResult(env.DB, domain, token, result, nowMs());
    } else {
      result = await checkResendDomain(
        domain,
        credential.trim(),
        dependencies.resendLookup ?? getExactResendDomain,
        currentTime
      );
      await saveResendResult(env.DB, domain, token, result, nowMs());
    }
    checked += 1;
  }

  return { state: 'completed', checked, skippedBusy, errorCode: null };
}

/**
 * Refreshes at most one due domain per provider per scheduled invocation. The
 * Cloudflare and Resend leases, timestamps, errors, and backoff are independent.
 * Every provider call here is read-only; address lifecycle and intent columns
 * are deliberately not changed by scheduled observations.
 */
export async function refreshMailDomainHealth(
  env: CloudflareEnv,
  dependencies: MailHealthRefreshDependencies = {}
): Promise<MailHealthRefreshSummary> {
  const [cloudflare, resend] = await Promise.allSettled([
    runProvider(
      env,
      'cloudflare',
      env.CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN?.trim() || env.CLOUDFLARE_EMAIL_ROUTING_TOKEN?.trim(),
      dependencies
    ),
    runProvider(env, 'resend', env.RESEND_API_KEY?.trim(), dependencies)
  ]);
  return {
    cloudflare: cloudflare.status === 'fulfilled'
      ? cloudflare.value
      : { state: 'unavailable', checked: 0, skippedBusy: 0, errorCode: 'cloudflare_scheduler_failed' },
    resend: resend.status === 'fulfilled'
      ? resend.value
      : { state: 'unavailable', checked: 0, skippedBusy: 0, errorCode: 'resend_scheduler_failed' }
  };
}
