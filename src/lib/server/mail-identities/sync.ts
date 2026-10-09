import type { CloudflareEnv } from '$lib/server/cloudflare';
import {
  CloudflareEmailRoutingClient, CloudflareEmailRoutingError, isExactRecipientRule,
  type CloudflareEmailRoutingRule
} from '$lib/server/cloudflare-email-routing';
import { ApiError } from '$lib/server/http/api';
import { domainOnboardingConfiguration, enrollMailDomain } from './domains';
import { normalizeCloudflareZoneId, normalizeMailDomain, normalizeManagedAddress } from './validation';

type SyncClient = Pick<CloudflareEmailRoutingClient, 'listZones' | 'listRules' | 'getCatchAll'>;

function workerRecipient(rule: CloudflareEmailRoutingRule, workerName: string) {
  const recipient = rule.matchers[0]?.value;
  if (!recipient || !isExactRecipientRule(rule, recipient) || rule.actions.length !== 1 ||
    rule.actions[0]?.type !== 'worker' || rule.actions[0]?.value.length !== 1 ||
    rule.actions[0]?.value[0] !== workerName) return null;
  try {
    if (!recipient.includes('@')) return null;
    const domainName = normalizeMailDomain(recipient.slice(recipient.lastIndexOf('@') + 1));
    return { domainName, ...normalizeManagedAddress(recipient, domainName) };
  } catch { return null; }
}

/** Discover provider-owned identities without creating, changing or claiming remote rules. */
export async function syncCloudflareMailIdentities(env: CloudflareEnv, ownerUserId: string, client?: SyncClient) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂不可用。');
  const configuration = domainOnboardingConfiguration(env);
  if (!configuration.available || !configuration.workerName) {
    throw new ApiError(503, 'MAIL_DOMAIN_ONBOARDING_NOT_CONFIGURED', '请先配置收信 Worker 和 Cloudflare Zone 读取权限。', undefined, undefined, false);
  }
  const owner = await env.DB.prepare('SELECT user_id FROM workspace_owner WHERE singleton = 1').first<{ user_id: string }>();
  if (owner?.user_id !== ownerUserId) {
    throw new ApiError(403, 'MAIL_IDENTITY_SYNC_OWNER_REQUIRED', '仅工作区所有者可以同步邮件配置。', undefined, undefined, false);
  }
  const workerName = configuration.workerName;
  const provider = client ?? new CloudflareEmailRoutingClient({
    token: (env.CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN?.trim() || env.CLOUDFLARE_EMAIL_ROUTING_TOKEN?.trim())!,
    timeoutMs: 5_000, maxRulePages: 10, deadlineAt: Date.now() + 25_000
  });
  const result = { domainsCreated: 0, addressesCreated: 0, skippedRules: 0,
    warnings: [] as Array<{ domainName: string; code: string }> };
  let zones;
  try { zones = await provider.listZones(env.MAIL_IDENTITY_ACCOUNT_ID!.trim()); } catch (error) {
    if (error instanceof CloudflareEmailRoutingError) {
      throw new ApiError(error.code === 'permission_denied' ? 403 : 502, 'MAIL_IDENTITY_DISCOVERY_FAILED',
        '无法读取 Cloudflare 域名，请检查 Token 的 Zone Read 权限后重试。', undefined, undefined, error.retryable);
    }
    throw error;
  }
  for (const rawZone of zones) {
    let zone;
    try {
      zone = { ...rawZone, id: normalizeCloudflareZoneId(rawZone.id), name: normalizeMailDomain(rawZone.name) };
      if (zone.accountId !== env.MAIL_IDENTITY_ACCOUNT_ID!.trim()) throw new Error('account_mismatch');
    } catch { throw new ApiError(502, 'MAIL_IDENTITY_DISCOVERY_FAILED', 'Cloudflare 返回的域名信息无效。'); }
    let rules;
    let catchAll;
    try {
      [rules, catchAll] = await Promise.all([provider.listRules(zone.id), provider.getCatchAll(zone.id)]);
    } catch (error) {
      result.warnings.push({ domainName: zone.name,
        code: error instanceof CloudflareEmailRoutingError ? error.code : 'upstream_failed' });
      continue;
    }
    const catchesForWorker = catchAll.enabled && catchAll.actions.length === 1 &&
      catchAll.actions[0]?.type === 'worker' && catchAll.actions[0]?.value.length === 1 &&
      catchAll.actions[0]?.value[0] === workerName;
    const recipients = rules.flatMap((rule) => {
      const identity = workerRecipient(rule, workerName);
      if (!identity || !(identity.domainName === zone.name || identity.domainName.endsWith('.' + zone.name))) {
        result.skippedRules += 1;
        return [];
      }
      // A competing exact recipient rule must not be promoted to an active mailbox.
      if (rules.filter((candidate) => isExactRecipientRule(candidate, identity.email)).length !== 1) {
        result.skippedRules += 1;
        return [];
      }
      return [{ ...identity, rule }];
    });
    const domainNames = new Set(recipients.map(({ domainName }) => domainName));
    if (catchesForWorker) domainNames.add(zone.name);
    for (const domainName of domainNames) {
      let domain;
      try {
        const enrolled = await enrollMailDomain(env, ownerUserId, { domainName, zoneId: zone.id }, { getZone: async () => zone });
        domain = enrolled.domain;
        if (enrolled.created) {
          result.domainsCreated += 1;
          // Mirror an existing, verified catch-all only on first import. Preserve later Owner choices.
          if (domainName === zone.name) {
            const target = !catchAll.enabled ? 'none' : catchesForWorker ? 'this_worker'
              : catchAll.actions[0]?.type === 'drop' ? 'drop' : 'external';
            const timestamp = new Date().toISOString();
            await env.DB.prepare(`UPDATE mail_domains SET catch_all_target = ?, catch_all_checked_at = ?,
              cloudflare_checked_at = ?, unknown_recipient_policy = ?, updated_at = ?
              WHERE id = ? AND owner_user_id = ? AND updated_at = ?`)
              .bind(target, timestamp, timestamp, catchesForWorker ? 'collect' : 'reject', timestamp,
                domain.id, ownerUserId, domain.updated_at).run();
          }
        }
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'MAIL_DOMAIN_ALREADY_CONFIGURED') throw error;
        result.warnings.push({ domainName, code: 'mapping_conflict' });
        continue;
      }
      for (const recipient of recipients.filter((item) => item.domainName === domainName)) {
        const timestamp = new Date().toISOString();
        const inserted = await env.DB.prepare(`INSERT INTO mail_addresses (
          id, owner_user_id, domain_id, email, local_part, receive_enabled, routing_state,
          routing_rule_id, routing_rule_source, routing_owner, created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, 'imported', ?, ?, 'imported', ?, ?
          WHERE EXISTS (SELECT 1 FROM mail_domains WHERE id = ? AND owner_user_id = ?
            AND cloudflare_zone_id = ? AND worker_name = ?)
          ON CONFLICT(email) DO NOTHING`)
          .bind(crypto.randomUUID(), ownerUserId, domain.id, recipient.email, recipient.localPart,
            Number(recipient.rule.enabled), recipient.rule.id, recipient.rule.source, timestamp, timestamp,
            domain.id, ownerUserId, zone.id, workerName).run();
        result.addressesCreated += Number(inserted.meta?.changes ?? 0);
      }
    }
  }
  return result;
}
