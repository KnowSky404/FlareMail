import type { CloudflareEnv } from '$lib/server/cloudflare';
import { mailHealthNextCheckAt } from '$lib/domain/mail/health';
import {
  CloudflareEmailRoutingClient,
  CloudflareEmailRoutingError,
  isExactRecipientRule,
  isExactWorkerEmailRule,
  isFlareMailManagedWorkerRule,
  type CloudflareCatchAll,
  type CloudflareEmailRoutingRule
} from '$lib/server/cloudflare-email-routing';
import { listManagedMailAddresses, getManagedMailDomain, type ManagedMailAddressRow } from '$lib/server/db/mail-identities';
import { getExactResendDomain, canSendFromResendDomain, ResendDomainError } from '$lib/server/resend-domains';
import { normalizeMailDomain } from './validation';

type CloudflareClient = Pick<CloudflareEmailRoutingClient, 'getZone' | 'listRules' | 'getCatchAll'>;
type ResendLookup = typeof getExactResendDomain;

export interface ManagedMailDomainCheckDependencies {
  cloudflareClient: CloudflareClient;
  resendLookup: ResendLookup;
  now?: () => string;
  randomUUID?: () => string;
}

export type AddressRouteCheck = {
  addressId: string;
  email: string;
  status: 'managed' | 'imported' | 'importable' | 'missing' | 'conflict' | 'duplicate' | 'deleted_route' | 'deleted_absent' | 'imported_preserved' | 'reject_route_preserved' | 'busy';
};

export interface ManagedMailDomainCheckResult {
  domainId: string;
  domainName: string;
  enabled: boolean;
  unknownRecipientPolicy: 'reject' | 'collect';
  cloudflare: {
    state: 'ready' | 'error';
    errorCode: string | null;
    zoneName: string | null;
    catchAllEnabled: boolean | null;
    catchAllTarget: 'unknown' | 'this_worker' | 'external' | 'drop' | 'none';
    checkedAt: string | null;
    addresses: AddressRouteCheck[];
  };
  resend: {
    state: 'verified' | 'pending' | 'failed' | 'missing' | 'not_configured' | 'error';
    sendingEnabled: boolean | null;
    checkedAt: string | null;
    errorCode: string | null;
  };
}

const isoNow = () => new Date().toISOString();
const addressCheckLeaseMs = 5 * 60 * 1000;
const domainCheckLeaseMs = 60 * 1000;

type HealthProvider = 'cloudflare' | 'resend';

async function acquireProviderCheckLease(
  db: D1Database,
  provider: HealthProvider,
  domain: ManagedMailAddressRow | { id: string; owner_user_id: string },
  token: string,
  timestamp: string
) {
  const expiresAt = new Date(Date.parse(timestamp) + domainCheckLeaseMs).toISOString();
  const result = await db.prepare(
    `UPDATE mail_domains SET ${provider}_check_token = ?, ${provider}_check_expires_at = ?, updated_at = ? ` +
    `WHERE id = ? AND owner_user_id = ? AND (${provider}_check_token IS NULL OR ${provider}_check_expires_at IS NULL OR ${provider}_check_expires_at <= ?)`
  ).bind(token, expiresAt, timestamp, domain.id, domain.owner_user_id, timestamp).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

function providerFailureIsRetryable(provider: HealthProvider, error: unknown) {
  if (provider === 'cloudflare' && error instanceof CloudflareEmailRoutingError) return error.retryable;
  if (provider === 'resend' && error instanceof ResendDomainError) {
    return ['rate_limited', 'timeout', 'network_failure', 'upstream_failed'].includes(error.code);
  }
  return true;
}

async function recordProviderCheckFailure(
  db: D1Database,
  provider: HealthProvider,
  domain: Awaited<ReturnType<typeof getManagedMailDomain>> & {},
  token: string,
  errorCode: string,
  retryable: boolean,
  timestamp: string
) {
  const failureCount = retryable ? Math.min(domain[`${provider}_failure_count` as 'cloudflare_failure_count' | 'resend_failure_count'] + 1, 1000) : 0;
  const nextCheckAt = mailHealthNextCheckAt(domain.id, Date.parse(timestamp), Math.max(1, failureCount), errorCode, retryable);
  await db.prepare(
    `UPDATE mail_domains SET ${provider}_error_code = ?, ${provider}_error_at = ?, ${provider}_failure_count = ?, ` +
    `${provider}_next_check_at = ?, ${provider}_check_token = NULL, ${provider}_check_expires_at = NULL, ` +
    (provider === 'cloudflare' ? 'last_error_code = ?, last_error_at = ?, ' : '') +
    'updated_at = ? WHERE id = ? AND owner_user_id = ? AND ' + `${provider}_check_token = ? AND ${provider}_check_expires_at > ?`
  ).bind(
    errorCode,
    timestamp,
    failureCount,
    nextCheckAt,
    ...(provider === 'cloudflare' ? [errorCode, timestamp] : []),
    timestamp,
    domain.id,
    domain.owner_user_id,
    token,
    timestamp
  ).run();
}

function catchAllTarget(catchAll: CloudflareCatchAll, workerName: string): ManagedMailDomainCheckResult['cloudflare']['catchAllTarget'] {
  if (!catchAll.enabled) return 'none';
  const action = catchAll.actions[0];
  if (!action) return 'unknown';
  if (action.type === 'drop') return 'drop';
  if (action.type === 'worker' && action.value.length === 1 && action.value[0] === workerName) return 'this_worker';
  return 'external';
}

function exactRecipientRules(rules: CloudflareEmailRoutingRule[], email: string) {
  return rules.filter((rule) => isExactRecipientRule(rule, email));
}

function routeStatus(
  rules: CloudflareEmailRoutingRule[],
  address: ManagedMailAddressRow,
  workerName: string
): AddressRouteCheck['status'] {
  const matches = exactRecipientRules(rules, address.email);
  if (address.lifecycle_status === 'deleted') {
    if (!matches.length) return 'deleted_absent';
    if (matches.length === 1 && address.delete_route_policy === 'retain_reject_route' && address.routing_owner === 'flaremail' &&
      isFlareMailManagedWorkerRule(matches[0]!, {
        addressId: address.id,
        email: address.email,
        workerName,
        ruleId: address.routing_rule_id
      })) return 'reject_route_preserved';
    if (matches.length === 1 && address.routing_owner === 'imported' &&
      matches[0]?.id === address.routing_rule_id && matches[0]?.source === address.routing_rule_source &&
      isExactWorkerEmailRule(matches[0]!, address.email, workerName)) return 'imported_preserved';
    return 'deleted_route';
  }
  if (matches.length > 1) return 'duplicate';
  const rule = matches[0];
  if (!rule) return 'missing';
  if (!isExactWorkerEmailRule(rule, address.email, workerName)) return 'conflict';
  if (address.routing_owner === 'imported') {
    return rule.id === address.routing_rule_id && rule.source === address.routing_rule_source ? 'imported' : 'importable';
  }
  if (address.routing_owner === 'flaremail') {
    if (isFlareMailManagedWorkerRule(rule, {
      addressId: address.id,
      email: address.email,
      workerName,
      ruleId: address.routing_rule_id
    })) return 'managed';
    if (address.routing_rule_id) return 'conflict';
  }
  return 'importable';
}

function classifyCloudflareError(error: unknown) {
  if (error instanceof CloudflareEmailRoutingError) return 'cloudflare_' + error.code;
  return 'cloudflare_check_failed';
}

function classifyResendError(error: unknown) {
  return error instanceof ResendDomainError ? 'resend_' + error.code : 'resend_check_failed';
}

function routeObservationUpdate(
  db: D1Database,
  address: ManagedMailAddressRow,
  ownerUserId: string,
  token: string,
  domainCheckToken: string,
  timestamp: string,
  setClause: string,
  values: unknown[]
) {
  return db.prepare(
    `UPDATE mail_addresses SET ${setClause} WHERE id = ? AND owner_user_id = ? AND operation_token = ? ` +
    'AND operation_expires_at > ? AND lifecycle_status = ? AND routing_state = ? ' +
    'AND routing_rule_id IS ? AND routing_rule_source IS ? AND routing_owner IS ? ' +
    'AND EXISTS (SELECT 1 FROM mail_domains WHERE id = ? AND owner_user_id = ? ' +
    'AND cloudflare_check_token = ? AND cloudflare_check_expires_at > ?)'
  ).bind(
    ...values,
    address.id,
    ownerUserId,
    token,
    timestamp,
    address.lifecycle_status,
    address.routing_state,
    address.routing_rule_id,
    address.routing_rule_source,
    address.routing_owner,
    address.domain_id,
    ownerUserId,
    domainCheckToken,
    timestamp
  );
}

async function releaseAddressCheckLeases(
  db: D1Database,
  ownerUserId: string,
  leases: Array<{ addressId: string; token: string }>
) {
  await Promise.all(leases.map(({ addressId, token }) => db.prepare(
    'UPDATE mail_addresses SET operation_token = NULL, operation_expires_at = NULL ' +
    'WHERE id = ? AND owner_user_id = ? AND operation_token = ?'
  ).bind(addressId, ownerUserId, token).run()));
}

export async function checkManagedMailDomain(
  env: CloudflareEnv,
  ownerUserId: string,
  domainId: string,
  dependencies?: ManagedMailDomainCheckDependencies
): Promise<ManagedMailDomainCheckResult> {
  if (!env.DB) throw new Error('D1 binding is unavailable.');
  const domain = await getManagedMailDomain(env.DB, ownerUserId, domainId);
  if (!domain) throw new Error('MAIL_DOMAIN_NOT_FOUND');
  const now = dependencies?.now ?? isoNow;
  const result: ManagedMailDomainCheckResult = {
    domainId: domain.id,
    domainName: domain.domain_name,
    enabled: Boolean(domain.enabled),
    unknownRecipientPolicy: domain.unknown_recipient_policy,
    cloudflare: {
      state: 'error', errorCode: null, zoneName: null, catchAllEnabled: null,
      catchAllTarget: 'unknown', checkedAt: null, addresses: []
    },
    resend: {
      state: 'not_configured', sendingEnabled: null, checkedAt: null, errorCode: null
    }
  };

  const randomUUID = dependencies?.randomUUID ?? (() => crypto.randomUUID());
  const resendKey = env.RESEND_API_KEY?.trim();
  const resendCheckToken = randomUUID();
  const resendLeaseAt = now();
  const resendLeaseAcquired = resendKey
    ? await acquireProviderCheckLease(env.DB, 'resend', domain, resendCheckToken, resendLeaseAt)
    : false;
  const routingToken = env.CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN?.trim() || env.CLOUDFLARE_EMAIL_ROUTING_TOKEN?.trim();
  const cloudflare = dependencies?.cloudflareClient ?? (routingToken
    ? new CloudflareEmailRoutingClient({
        token: routingToken,
        timeoutMs: 4_000,
        maxRulePages: 10,
        deadlineAt: Date.parse(now()) + 12_000
      })
    : null);
  if (!cloudflare) {
    result.cloudflare.errorCode = 'cloudflare_token_missing';
    await env.DB.prepare(
      'UPDATE mail_domains SET cloudflare_error_code = ?, cloudflare_error_at = ?, last_error_code = ?, last_error_at = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?'
    ).bind(result.cloudflare.errorCode, now(), result.cloudflare.errorCode, now(), now(), domain.id, ownerUserId).run();
  } else {
    const cloudflareCheckToken = randomUUID();
    const cloudflareLeaseAt = now();
    const cloudflareLeaseAcquired = await acquireProviderCheckLease(
      env.DB, 'cloudflare', domain, cloudflareCheckToken, cloudflareLeaseAt
    );
    if (!cloudflareLeaseAcquired) {
      result.cloudflare.errorCode = 'cloudflare_check_in_progress';
    } else {
    const addresses = (await listManagedMailAddresses(env.DB, ownerUserId))
      .filter((address) => address.domain_id === domain.id);
    const leaseAt = now();
    const leaseExpiry = new Date(Date.parse(leaseAt) + addressCheckLeaseMs).toISOString();
    const leases: Array<{ address: ManagedMailAddressRow; token: string }> = [];
    const busyAddresses = new Set<string>();
    for (const address of addresses) {
      const leaseToken = randomUUID();
      const acquired = await env.DB.prepare(
        'UPDATE mail_addresses SET operation_token = ?, operation_expires_at = ?, updated_at = ? ' +
        'WHERE id = ? AND owner_user_id = ? AND domain_id = ? AND lifecycle_status = ? AND routing_state = ? ' +
        'AND routing_rule_id IS ? AND routing_rule_source IS ? AND routing_owner IS ? ' +
        'AND receive_enabled = ? AND send_enabled = ? AND is_default_sender = ? ' +
        'AND (operation_token IS NULL OR operation_expires_at <= ?)'
      ).bind(
        leaseToken,
        leaseExpiry,
        leaseAt,
        address.id,
        ownerUserId,
        domain.id,
        address.lifecycle_status,
        address.routing_state,
        address.routing_rule_id,
        address.routing_rule_source,
        address.routing_owner,
        address.receive_enabled,
        address.send_enabled,
        address.is_default_sender,
        leaseAt
      ).run();
      if (Number(acquired.meta?.changes ?? 0) === 1) leases.push({ address, token: leaseToken });
      else busyAddresses.add(address.id);
    }

    const checks = await Promise.allSettled([
      cloudflare.getZone(domain.cloudflare_zone_id),
      cloudflare.listRules(domain.cloudflare_zone_id),
      cloudflare.getCatchAll(domain.cloudflare_zone_id)
    ]);
    const rejected = checks.find((check) => check.status === 'rejected');
    if (rejected?.status === 'rejected') {
      result.cloudflare.errorCode = classifyCloudflareError(rejected.reason);
      await recordProviderCheckFailure(
        env.DB, 'cloudflare', domain, cloudflareCheckToken, result.cloudflare.errorCode,
        providerFailureIsRetryable('cloudflare', rejected.reason), now()
      );
      await releaseAddressCheckLeases(env.DB, ownerUserId, leases.map(({ address, token: leaseToken }) => ({ addressId: address.id, token: leaseToken })));
    } else {
      const [zoneCheck, rulesCheck, catchAllCheck] = checks as [
        PromiseFulfilledResult<Awaited<ReturnType<CloudflareClient['getZone']>>>,
        PromiseFulfilledResult<Awaited<ReturnType<CloudflareClient['listRules']>>>,
        PromiseFulfilledResult<Awaited<ReturnType<CloudflareClient['getCatchAll']>>>
      ];
      const zone = zoneCheck.value;
      let zoneName: string | null = null;
      try {
        zoneName = normalizeMailDomain(zone.name);
      } catch {
        // Invalid provider data is a mapping conflict and must release the leases below.
      }
      const domainMatchesZone = Boolean(zoneName &&
        (domain.domain_name === zoneName || domain.domain_name.endsWith('.' + zoneName)));
      const accountMatches = !domain.cloudflare_account_id || !zone.accountId || domain.cloudflare_account_id === zone.accountId;
      if (!zoneName || zone.id !== domain.cloudflare_zone_id || !domainMatchesZone || !accountMatches) {
        result.cloudflare.errorCode = 'cloudflare_zone_mapping_conflict';
        await recordProviderCheckFailure(
          env.DB, 'cloudflare', domain, cloudflareCheckToken, result.cloudflare.errorCode, false, now()
        );
        await releaseAddressCheckLeases(env.DB, ownerUserId, leases.map(({ address, token: leaseToken }) => ({ addressId: address.id, token: leaseToken })));
      } else {
        const timestamp = now();
        const leaseTokens = new Map(leases.map(({ address, token: leaseToken }) => [address.id, leaseToken]));
        const routeChecks = addresses.map((address) => ({
          address,
          token: leaseTokens.get(address.id),
          status: busyAddresses.has(address.id) ? 'busy' as const : routeStatus(rulesCheck.value, address, domain.worker_name)
        }));
        const target = catchAllTarget(catchAllCheck.value, domain.worker_name);
        const hasManagedRouteDrift = routeChecks.some(({ address, status }) =>
          address.routing_owner === 'flaremail' &&
          ['missing', 'conflict', 'duplicate', 'deleted_route'].includes(status)
        );
        const cloudflareHealthError = domain.unknown_recipient_policy === 'collect' && target !== 'this_worker'
          ? 'cloudflare_collect_catch_all_unavailable'
          : hasManagedRouteDrift ? 'cloudflare_managed_route_needs_review' : null;
        const statements = [
          env.DB.prepare(
            'UPDATE mail_domains SET cloudflare_account_id = COALESCE(cloudflare_account_id, ?), ' +
            'catch_all_target = ?, catch_all_checked_at = ?, cloudflare_checked_at = ?, ' +
            'cloudflare_error_code = ?, cloudflare_error_at = ?, cloudflare_failure_count = 0, ' +
            'cloudflare_next_check_at = ?, last_error_code = ?, last_error_at = ?, updated_at = ? ' +
            'WHERE id = ? AND owner_user_id = ? AND cloudflare_check_token = ? AND cloudflare_check_expires_at > ?'
          ).bind(
            zone.accountId,
            target,
            timestamp,
            timestamp,
            cloudflareHealthError,
            cloudflareHealthError ? timestamp : null,
            mailHealthNextCheckAt(domain.id, Date.parse(timestamp), 0, cloudflareHealthError, false),
            cloudflareHealthError,
            cloudflareHealthError ? timestamp : null,
            timestamp,
            domain.id,
            ownerUserId,
            cloudflareCheckToken,
            timestamp
          ),
          ...routeChecks.flatMap(({ address, token: leaseToken, status }) => {
            if (!leaseToken) return [];
            if (status === 'managed' || status === 'imported') {
              const rule = exactRecipientRules(rulesCheck.value, address.email)[0]!;
              return [routeObservationUpdate(
                env.DB,
                address,
                ownerUserId,
                leaseToken,
                cloudflareCheckToken,
                timestamp,
                'routing_state = ?, routing_rule_id = ?, routing_rule_source = ?, ' +
                'routing_owner = ?, last_error_code = NULL, last_error_at = NULL, operation_token = NULL, ' +
                'operation_expires_at = NULL, updated_at = ?',
                [
                  status === 'imported' ? 'imported' : 'active',
                  rule.id,
                  rule.source,
                  status === 'imported' ? 'imported' : 'flaremail',
                  timestamp
                ]
              )];
            }
            if (status === 'deleted_absent') {
              const imported = address.routing_owner === 'imported';
              return [routeObservationUpdate(
                env.DB,
                address,
                ownerUserId,
                leaseToken,
                cloudflareCheckToken,
                timestamp,
                'routing_state = ?, routing_rule_id = CASE WHEN ? = 1 THEN routing_rule_id ELSE NULL END, ' +
                'routing_rule_source = CASE WHEN ? = 1 THEN routing_rule_source ELSE NULL END, ' +
                'routing_owner = CASE WHEN ? = 1 THEN routing_owner ELSE NULL END, ' +
                'last_error_code = NULL, last_error_at = NULL, operation_token = NULL, operation_expires_at = NULL, updated_at = ?',
                [imported ? 'imported' : 'deleted', imported ? 1 : 0, imported ? 1 : 0, imported ? 1 : 0, timestamp]
              )];
            }
            if (status === 'missing') {
              const missingState = address.routing_rule_id ? 'error' : 'pending';
              const errorCode = missingState === 'error' ? 'cloudflare_route_missing' : null;
              return [routeObservationUpdate(
                env.DB,
                address,
                ownerUserId,
                leaseToken,
                cloudflareCheckToken,
                timestamp,
                'routing_state = ?, last_error_code = ?, ' +
                'last_error_at = ?, operation_token = NULL, operation_expires_at = NULL, updated_at = ?',
                [missingState, errorCode, errorCode ? timestamp : null, timestamp]
              )];
            }
            const stateError = status === 'duplicate'
              ? 'cloudflare_duplicate_exact_rules'
              : status === 'deleted_route' ? 'cloudflare_deleted_address_route_present' :
                status === 'conflict' ? 'cloudflare_external_rule_conflict' : null;
            if (!stateError) {
              return [routeObservationUpdate(
                env.DB,
                address,
                ownerUserId,
                leaseToken,
                cloudflareCheckToken,
                timestamp,
                'operation_token = NULL, operation_expires_at = NULL',
                []
              )];
            }
            return [routeObservationUpdate(
                env.DB,
                address,
                ownerUserId,
                leaseToken,
                cloudflareCheckToken,
                timestamp,
              'routing_state = \'error\', last_error_code = ?, ' +
              'last_error_at = ?, operation_token = NULL, operation_expires_at = NULL, updated_at = ?',
              [stateError, timestamp, timestamp]
            )];
          }),
          env.DB.prepare(
            'UPDATE mail_domains SET cloudflare_check_token = NULL, cloudflare_check_expires_at = NULL ' +
            'WHERE id = ? AND owner_user_id = ? AND cloudflare_check_token = ?'
          ).bind(domain.id, ownerUserId, cloudflareCheckToken)
        ];
        const outcomes = await env.DB.batch(statements);
        const cloudflareCommitted = Number(outcomes[0]?.meta?.changes ?? 0) === 1;
        routeChecks.filter(({ token: leaseToken }) => Boolean(leaseToken)).forEach((check, index) => {
          if (Number(outcomes[index + 1]?.meta?.changes ?? 0) !== 1) check.status = 'busy';
        });
        result.cloudflare = {
          state: cloudflareCommitted ? 'ready' : 'error',
          errorCode: cloudflareCommitted ? cloudflareHealthError : 'cloudflare_check_superseded',
          zoneName,
          catchAllEnabled: catchAllCheck.value.enabled, catchAllTarget: target,
          checkedAt: timestamp,
          addresses: routeChecks.map(({ address, status }) => ({ addressId: address.id, email: address.email, status }))
        };
      }
    }
    }
  }

  if (!resendKey) return result;
  if (!resendLeaseAcquired) {
    result.resend = {
      state: 'error', sendingEnabled: null, checkedAt: null, errorCode: 'resend_check_in_progress'
    };
    return result;
  }
  try {
    const startedAt = Date.parse(resendLeaseAt);
    const resendDomain = await (dependencies?.resendLookup ?? getExactResendDomain)(
      resendKey,
      domain.domain_name,
      { timeoutMs: 4_000, deadlineAt: startedAt + 10_000 }
    );
    const checkedAt = now();
    const sendingEnabled = resendDomain ? resendDomain.sendingEnabled === true : null;
    const ready = canSendFromResendDomain(resendDomain, domain.domain_name);
    const state: ManagedMailDomainCheckResult['resend']['state'] = !resendDomain
      ? 'missing'
      : ready ? 'verified' : resendDomain.status === 'failed' ? 'failed' : 'pending';
    const knownErrorCode = !resendDomain ? 'resend_domain_missing' : !ready
      ? resendDomain.status === 'failed' ? 'resend_domain_failed' :
        sendingEnabled === false ? 'resend_sending_disabled' : 'resend_domain_not_verified'
      : null;
    const saved = await env.DB.prepare(
      'UPDATE mail_domains SET resend_domain_id = ?, resend_status = ?, resend_sending_status = ?, ' +
      'resend_checked_at = ?, resend_error_code = ?, resend_error_at = ?, resend_failure_count = 0, ' +
      'resend_next_check_at = ?, resend_check_token = NULL, resend_check_expires_at = NULL, updated_at = ? ' +
      'WHERE id = ? AND owner_user_id = ? AND resend_check_token = ? AND resend_check_expires_at > ?'
    ).bind(
      resendDomain?.id ?? null,
      ready ? 'verified' : resendDomain?.status === 'failed' ? 'failed' : 'pending',
      sendingEnabled === null ? 'unknown' : sendingEnabled ? 'enabled' : 'disabled',
      checkedAt,
      knownErrorCode,
      knownErrorCode ? checkedAt : null,
      mailHealthNextCheckAt(domain.id, Date.parse(checkedAt), 0, knownErrorCode, false),
      checkedAt,
      domain.id,
      ownerUserId,
      resendCheckToken,
      checkedAt
    ).run();
    result.resend = Number(saved.meta?.changes ?? 0) === 1
      ? { state, sendingEnabled, checkedAt, errorCode: knownErrorCode }
      : { state: 'error', sendingEnabled, checkedAt: null, errorCode: 'resend_check_superseded' };
  } catch (error) {
    result.resend.errorCode = classifyResendError(error);
    result.resend.state = 'error';
    await recordProviderCheckFailure(
      env.DB,
      'resend',
      domain,
      resendCheckToken,
      result.resend.errorCode,
      providerFailureIsRetryable('resend', error),
      now()
    );
  }

  return result;
}
