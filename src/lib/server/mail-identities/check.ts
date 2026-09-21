import type { CloudflareEnv } from '$lib/server/cloudflare';
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
  status: 'managed' | 'imported' | 'importable' | 'missing' | 'conflict' | 'duplicate' | 'deleted_route' | 'deleted_absent' | 'imported_preserved' | 'busy';
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
  timestamp: string,
  setClause: string,
  values: unknown[]
) {
  return db.prepare(
    `UPDATE mail_addresses SET ${setClause} WHERE id = ? AND owner_user_id = ? AND operation_token = ? ` +
    'AND operation_expires_at > ? AND lifecycle_status = ? AND routing_state = ? ' +
    'AND routing_rule_id IS ? AND routing_rule_source IS ? AND routing_owner IS ?'
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
    address.routing_owner
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

  const token = env.CLOUDFLARE_EMAIL_ROUTING_TOKEN?.trim();
  const cloudflare = dependencies?.cloudflareClient ?? (token
    ? new CloudflareEmailRoutingClient({ token })
    : null);
  if (!cloudflare) {
    result.cloudflare.errorCode = 'cloudflare_token_missing';
    await env.DB.prepare(
      'UPDATE mail_domains SET last_error_code = ?, last_error_at = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?'
    ).bind(result.cloudflare.errorCode, now(), now(), domain.id, ownerUserId).run();
  } else {
    const addresses = (await listManagedMailAddresses(env.DB, ownerUserId))
      .filter((address) => address.domain_id === domain.id);
    const leaseAt = now();
    const leaseExpiry = new Date(Date.parse(leaseAt) + addressCheckLeaseMs).toISOString();
    const leases: Array<{ address: ManagedMailAddressRow; token: string }> = [];
    const busyAddresses = new Set<string>();
    for (const address of addresses) {
      const leaseToken = (dependencies?.randomUUID ?? (() => crypto.randomUUID()))();
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
      await env.DB.prepare(
        'UPDATE mail_domains SET last_error_code = ?, last_error_at = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?'
      ).bind(result.cloudflare.errorCode, now(), now(), domain.id, ownerUserId).run();
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
        await env.DB.prepare(
          'UPDATE mail_domains SET last_error_code = ?, last_error_at = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?'
        ).bind(result.cloudflare.errorCode, now(), now(), domain.id, ownerUserId).run();
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
        const statements = [
          env.DB.prepare(
            'UPDATE mail_domains SET cloudflare_account_id = COALESCE(cloudflare_account_id, ?), ' +
            'catch_all_target = ?, catch_all_checked_at = ?, cloudflare_checked_at = ?, ' +
            'last_error_code = NULL, last_error_at = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ?'
          ).bind(zone.accountId, target, timestamp, timestamp, timestamp, domain.id, ownerUserId),
          ...routeChecks.flatMap(({ address, token: leaseToken, status }) => {
            if (!leaseToken) return [];
            if (status === 'managed' || status === 'imported') {
              const rule = exactRecipientRules(rulesCheck.value, address.email)[0]!;
              return [routeObservationUpdate(
                env.DB,
                address,
                ownerUserId,
                leaseToken,
                timestamp,
                'routing_state = ?, routing_rule_id = ?, routing_rule_source = ?, ' +
                'routing_owner = ?, receive_enabled = CASE WHEN lifecycle_status = \'active\' THEN 1 ELSE 0 END, ' +
                'last_error_code = NULL, last_error_at = NULL, operation_token = NULL, ' +
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
                timestamp,
                'routing_state = ?, routing_rule_id = CASE WHEN ? = 1 THEN routing_rule_id ELSE NULL END, ' +
                'routing_rule_source = CASE WHEN ? = 1 THEN routing_rule_source ELSE NULL END, ' +
                'routing_owner = CASE WHEN ? = 1 THEN routing_owner ELSE NULL END, receive_enabled = 0, ' +
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
                timestamp,
                'routing_state = ?, receive_enabled = 0, last_error_code = ?, ' +
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
              timestamp,
              'routing_state = \'error\', receive_enabled = 0, last_error_code = ?, ' +
              'last_error_at = ?, operation_token = NULL, operation_expires_at = NULL, updated_at = ?',
              [stateError, timestamp, timestamp]
            )];
          })
        ];
        const outcomes = await env.DB.batch(statements);
        routeChecks.filter(({ token: leaseToken }) => Boolean(leaseToken)).forEach((check, index) => {
          if (Number(outcomes[index + 1]?.meta?.changes ?? 0) !== 1) check.status = 'busy';
        });
        result.cloudflare = {
          state: 'ready', errorCode: null, zoneName,
          catchAllEnabled: catchAllCheck.value.enabled, catchAllTarget: target,
          checkedAt: timestamp,
          addresses: routeChecks.map(({ address, status }) => ({ addressId: address.id, email: address.email, status }))
        };
      }
    }
  }

  const resendKey = env.RESEND_API_KEY?.trim();
  if (!resendKey) return result;
  try {
    const resendDomain = await (dependencies?.resendLookup ?? getExactResendDomain)(resendKey, domain.domain_name);
    const checkedAt = now();
    const sendingEnabled = resendDomain ? resendDomain.sendingEnabled === true : null;
    const ready = canSendFromResendDomain(resendDomain, domain.domain_name);
    const state: ManagedMailDomainCheckResult['resend']['state'] = !resendDomain
      ? 'missing'
      : ready ? 'verified' : resendDomain.status === 'failed' ? 'failed' : 'pending';
    await env.DB.prepare(
      'UPDATE mail_domains SET resend_domain_id = ?, resend_status = ?, resend_sending_status = ?, ' +
      'resend_checked_at = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?'
    ).bind(
      resendDomain?.id ?? null,
      ready ? 'verified' : resendDomain?.status === 'failed' ? 'failed' : 'pending',
      sendingEnabled === null ? 'unknown' : sendingEnabled ? 'enabled' : 'disabled',
      checkedAt,
      checkedAt,
      domain.id,
      ownerUserId
    ).run();
    result.resend = { state, sendingEnabled, checkedAt, errorCode: null };
  } catch (error) {
    result.resend.errorCode = classifyResendError(error);
    result.resend.state = 'error';
  }

  return result;
}
