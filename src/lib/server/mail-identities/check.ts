import type { CloudflareEnv } from '$lib/server/cloudflare';
import {
  CloudflareEmailRoutingClient,
  CloudflareEmailRoutingError,
  isExactWorkerEmailRule,
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
}

export type AddressRouteCheck = {
  addressId: string;
  email: string;
  status: 'managed' | 'imported' | 'importable' | 'missing' | 'conflict' | 'duplicate' | 'deleted_route';
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

function catchAllTarget(catchAll: CloudflareCatchAll, workerName: string): ManagedMailDomainCheckResult['cloudflare']['catchAllTarget'] {
  if (!catchAll.enabled) return 'none';
  const action = catchAll.actions[0];
  if (!action) return 'unknown';
  if (action.type === 'drop') return 'drop';
  if (action.type === 'worker' && action.value.length === 1 && action.value[0] === workerName) return 'this_worker';
  return 'external';
}

function exactRecipientRules(rules: CloudflareEmailRoutingRule[], email: string) {
  return rules.filter((rule) => rule.matchers.length === 1 &&
    rule.matchers[0]?.type === 'literal' &&
    rule.matchers[0]?.field === 'to' &&
    rule.matchers[0]?.value?.toLowerCase() === email.toLowerCase());
}

function hasFlareMailMarker(rule: CloudflareEmailRoutingRule, address: ManagedMailAddressRow) {
  return rule.enabled &&
    rule.source === 'api' &&
    rule.name === 'FlareMail managed address ' + address.id &&
    rule.actions.length === 1 &&
    rule.actions[0]?.type === 'worker' &&
    rule.actions[0]?.value.length === 1;
}

function routeStatus(
  rules: CloudflareEmailRoutingRule[],
  address: ManagedMailAddressRow,
  workerName: string
): AddressRouteCheck['status'] {
  const matches = exactRecipientRules(rules, address.email);
  if (address.lifecycle_status === 'deleted') return matches.length ? 'deleted_route' : 'missing';
  if (matches.length > 1) return 'duplicate';
  const rule = matches[0];
  if (!rule) return 'missing';
  if (!isExactWorkerEmailRule(rule, address.email, workerName)) return 'conflict';
  if (address.routing_owner === 'imported') {
    return rule.id === address.routing_rule_id && rule.source === address.routing_rule_source ? 'imported' : 'importable';
  }
  if (address.routing_owner === 'flaremail' && hasFlareMailMarker(rule, address)) return 'managed';
  return 'importable';
}

function classifyCloudflareError(error: unknown) {
  if (error instanceof CloudflareEmailRoutingError) return 'cloudflare_' + error.code;
  return 'cloudflare_check_failed';
}

function classifyResendError(error: unknown) {
  return error instanceof ResendDomainError ? 'resend_' + error.code : 'resend_check_failed';
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
    } else {
      const [zoneCheck, rulesCheck, catchAllCheck] = checks as [
        PromiseFulfilledResult<Awaited<ReturnType<CloudflareClient['getZone']>>>,
        PromiseFulfilledResult<Awaited<ReturnType<CloudflareClient['listRules']>>>,
        PromiseFulfilledResult<Awaited<ReturnType<CloudflareClient['getCatchAll']>>>
      ];
      const zone = zoneCheck.value;
      const zoneName = normalizeMailDomain(zone.name);
      const domainMatchesZone = domain.domain_name === zoneName || domain.domain_name.endsWith('.' + zoneName);
      const accountMatches = !domain.cloudflare_account_id || !zone.accountId || domain.cloudflare_account_id === zone.accountId;
      if (zone.id !== domain.cloudflare_zone_id || !domainMatchesZone || !accountMatches) {
        result.cloudflare.errorCode = 'cloudflare_zone_mapping_conflict';
        await env.DB.prepare(
          'UPDATE mail_domains SET last_error_code = ?, last_error_at = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?'
        ).bind(result.cloudflare.errorCode, now(), now(), domain.id, ownerUserId).run();
      } else {
        const timestamp = now();
        const addresses = await listManagedMailAddresses(env.DB, ownerUserId);
        const domainAddresses = addresses.filter((address) => address.domain_id === domain.id);
        const routeChecks = domainAddresses.map((address) => ({
          address,
          status: routeStatus(rulesCheck.value, address, domain.worker_name)
        }));
        const target = catchAllTarget(catchAllCheck.value, domain.worker_name);
        const statements = [
          env.DB.prepare(
            'UPDATE mail_domains SET cloudflare_account_id = COALESCE(cloudflare_account_id, ?), ' +
            'catch_all_target = ?, catch_all_checked_at = ?, cloudflare_checked_at = ?, ' +
            'last_error_code = NULL, last_error_at = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ?'
          ).bind(zone.accountId, target, timestamp, timestamp, timestamp, domain.id, ownerUserId),
          ...routeChecks.map(({ address, status }) => {
            if (status === 'managed' || status === 'imported') {
              return env.DB.prepare(
                'UPDATE mail_addresses SET routing_state = ?, routing_rule_id = ?, routing_rule_source = ?, ' +
                'routing_owner = ?, receive_enabled = CASE WHEN lifecycle_status = \'active\' THEN 1 ELSE 0 END, ' +
                'last_error_code = NULL, last_error_at = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ?'
              ).bind(
                status === 'imported' ? 'imported' : 'active',
                exactRecipientRules(rulesCheck.value, address.email)[0]?.id ?? null,
                exactRecipientRules(rulesCheck.value, address.email)[0]?.source ?? null,
                status === 'imported' ? 'imported' : 'flaremail',
                timestamp,
                address.id,
                ownerUserId
              );
            }
            if (status === 'missing') {
              const missingState = address.lifecycle_status === 'deleted'
                ? 'deleting'
                : address.routing_rule_id ? 'error' : 'pending';
              return env.DB.prepare(
                'UPDATE mail_addresses SET routing_state = ?, receive_enabled = 0, ' +
                'last_error_code = CASE WHEN ? = \'error\' THEN \'cloudflare_route_missing\' ELSE NULL END, ' +
                'last_error_at = CASE WHEN ? = \'error\' THEN ? ELSE NULL END, updated_at = ? ' +
                'WHERE id = ? AND owner_user_id = ?'
              ).bind(missingState, missingState, missingState, timestamp, timestamp, address.id, ownerUserId);
            }
            const stateError = status === 'duplicate'
              ? 'cloudflare_duplicate_exact_rules'
              : status === 'deleted_route' ? 'cloudflare_deleted_address_route_present' :
                status === 'conflict' ? 'cloudflare_external_rule_conflict' : null;
            if (!stateError) return env.DB.prepare('SELECT 1').bind();
            return env.DB.prepare(
              'UPDATE mail_addresses SET routing_state = ?, receive_enabled = 0, last_error_code = ?, ' +
              'last_error_at = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?'
            ).bind(status === 'deleted_route' ? 'deleting' : 'error', stateError, timestamp, timestamp, address.id, ownerUserId);
          })
        ];
        await env.DB.batch(statements);
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
