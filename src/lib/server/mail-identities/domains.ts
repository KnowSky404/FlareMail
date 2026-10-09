import type { CloudflareEnv } from '$lib/server/cloudflare';
import { CloudflareEmailRoutingClient, CloudflareEmailRoutingError } from '$lib/server/cloudflare-email-routing';
import { getManagedMailDomain } from '$lib/server/db/mail-identities';
import { ApiError } from '$lib/server/http/api';
import { isMailHealthFresh } from '$lib/domain/mail/health';
import { MailIdentityValidationError, normalizeCloudflareZoneId, normalizeEmailWorkerName, normalizeMailDomain } from './validation';

export function domainOnboardingConfiguration(env: CloudflareEnv) {
  const workerName = env.MAIL_IDENTITY_WORKER_NAME?.trim() ?? '';
  let workerConfigured = false;
  try {
    workerConfigured = Boolean(workerName && normalizeEmailWorkerName(workerName) && /^[a-f0-9]{32}$/u.test(env.MAIL_IDENTITY_ACCOUNT_ID?.trim() ?? ''));
  } catch { /* Invalid deployment config. */ }
  return {
    workerName: workerConfigured ? workerName : null,
    available: workerConfigured && Boolean(env.CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN?.trim() || env.CLOUDFLARE_EMAIL_ROUTING_TOKEN?.trim()),
    canManageRouting: Boolean(env.CLOUDFLARE_EMAIL_ROUTING_TOKEN?.trim())
  };
}

export async function enrollMailDomain(
  env: CloudflareEnv, ownerUserId: string, input: { domainName: string; zoneId: string },
  client?: Pick<CloudflareEmailRoutingClient, 'getZone'>
) {
  const configuration = domainOnboardingConfiguration(env);
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂不可用。');
  if (!configuration.available || !configuration.workerName) {
    throw new ApiError(503, 'MAIL_DOMAIN_ONBOARDING_NOT_CONFIGURED', '域名接入尚未配置，请配置收信 Worker 和 Cloudflare Zone 读取权限。', undefined, undefined, false);
  }
  let domainName: string;
  let zoneId: string;
  try {
    domainName = normalizeMailDomain(input.domainName);
    zoneId = normalizeCloudflareZoneId(input.zoneId);
  } catch (error) {
    if (error instanceof MailIdentityValidationError) throw new ApiError(400, 'MAIL_DOMAIN_INPUT_INVALID', '请输入有效的域名和 Cloudflare Zone ID。', undefined, undefined, false);
    throw error;
  }
  const provider = client ?? new CloudflareEmailRoutingClient({
    token: (env.CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN?.trim() || env.CLOUDFLARE_EMAIL_ROUTING_TOKEN?.trim())!,
    timeoutMs: 5_000
  });
  let zone;
  try { zone = await provider.getZone(zoneId); } catch (error) {
    if (error instanceof CloudflareEmailRoutingError) {
      throw new ApiError(error.code === 'permission_denied' ? 403 : 502, 'MAIL_DOMAIN_ZONE_CHECK_FAILED',
        '无法核验 Cloudflare Zone，请检查 Zone ID 和 Token 的 Zone Read 权限。', undefined, undefined, error.retryable);
    }
    throw error;
  }
  let zoneName: string;
  try { zoneName = normalizeMailDomain(zone.name); } catch {
    throw new ApiError(502, 'MAIL_DOMAIN_ZONE_CHECK_FAILED', 'Cloudflare 返回的域名信息无效。');
  }
  if (zone.id !== zoneId || !(domainName === zoneName || domainName.endsWith('.' + zoneName)) ||
    !zone.accountId || (env.MAIL_IDENTITY_ACCOUNT_ID?.trim() && zone.accountId !== env.MAIL_IDENTITY_ACCOUNT_ID.trim())) {
    throw new ApiError(409, 'MAIL_DOMAIN_ZONE_MISMATCH', '域名与此 Cloudflare Zone 或部署账号不匹配。', undefined, undefined, false);
  }
  // Never replace an existing mapping, including a row owned by another user.
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO mail_domains (
    id, owner_user_id, domain_name, cloudflare_zone_id, cloudflare_account_id, worker_name,
    unknown_recipient_policy, created_at, updated_at
  ) SELECT ?, ?, ?, ?, ?, ?, 'reject', ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM mail_domains WHERE domain_name = ? COLLATE NOCASE)
    ON CONFLICT DO NOTHING`).bind(id, ownerUserId, domainName, zoneId, zone.accountId,
      configuration.workerName, timestamp, timestamp, domainName).run();
  const domain = await env.DB.prepare('SELECT id FROM mail_domains WHERE owner_user_id = ? AND domain_name = ? COLLATE NOCASE')
    .bind(ownerUserId, domainName).first<{ id: string }>();
  const stored = domain ? await getManagedMailDomain(env.DB, ownerUserId, domain.id) : null;
  if (!stored || stored.cloudflare_zone_id !== zoneId || stored.cloudflare_account_id !== zone.accountId || stored.worker_name !== configuration.workerName) {
    throw new ApiError(409, 'MAIL_DOMAIN_ALREADY_CONFIGURED', '此域名已有其他接入配置，不可覆盖。', undefined, undefined, false);
  }
  return { domain: stored, created: stored.id === id };
}

export async function updateMailDomain(
  env: CloudflareEnv, ownerUserId: string, domainId: string,
  input: { enabled?: boolean; unknownRecipientPolicy?: 'reject' | 'collect' }
) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂不可用。');
  const domain = await getManagedMailDomain(env.DB, ownerUserId, domainId);
  if (!domain) throw new ApiError(404, 'MAIL_DOMAIN_NOT_FOUND', '邮件域名不存在。', undefined, undefined, false);
  if (input.unknownRecipientPolicy === 'collect' && domain.unknown_recipient_policy !== 'collect' &&
    (domain.catch_all_target !== 'this_worker' || !isMailHealthFresh(domain.catch_all_checked_at) || domain.cloudflare_error_code)) {
    throw new ApiError(409, 'MAIL_DOMAIN_COLLECT_NOT_READY', '请先检查域名，确认有效的 catch-all 指向本应用，再启用未知地址收集。', undefined, undefined, false);
  }
  // Preserve the mapping, address preferences, and all historical mail.
  const result = await env.DB.prepare(`UPDATE mail_domains SET
    enabled = COALESCE(?, enabled), unknown_recipient_policy = COALESCE(?, unknown_recipient_policy), updated_at = ?
    WHERE id = ? AND owner_user_id = ? AND updated_at = ?`)
    .bind(input.enabled === undefined ? null : Number(input.enabled), input.unknownRecipientPolicy ?? null,
      new Date().toISOString(), domainId, ownerUserId, domain.updated_at).run();
  if (result.meta.changes !== 1) throw new ApiError(409, 'MAIL_DOMAIN_CHANGED', '域名配置已变化，请刷新后重试。', undefined, undefined, false);
  return getManagedMailDomain(env.DB, ownerUserId, domainId);
}
