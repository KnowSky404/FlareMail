import type { CloudflareEnv } from '$lib/server/cloudflare';
import { getManagedMailAddress, getManagedMailDomain, type ManagedMailAddressRow } from '$lib/server/db/mail-identities';
import { ApiError } from '$lib/server/http/api';
import {
  CloudflareEmailRoutingClient,
  CloudflareEmailRoutingError,
  isExactWorkerEmailRule,
  type CloudflareEmailRoutingRule
} from '$lib/server/cloudflare-email-routing';
import {
  MailIdentityValidationError,
  normalizeAddressSignature,
  normalizeDisplayName,
  normalizeManagedAddress
} from './validation';

const operationLeaseMs = 5 * 60 * 1000;
const isoNow = () => new Date().toISOString();

function cloudflareClient(env: CloudflareEnv) {
  const token = env.CLOUDFLARE_EMAIL_ROUTING_TOKEN?.trim();
  if (!token) throw new CloudflareEmailRoutingError('token_missing');
  return new CloudflareEmailRoutingClient({ token });
}

function cloudflareApiError(error: CloudflareEmailRoutingError): ApiError {
  const mappings: Record<CloudflareEmailRoutingError['code'], { status: number; code: string; message: string }> = {
    token_missing: { status: 503, code: 'CLOUDFLARE_ROUTING_NOT_CONFIGURED', message: 'Cloudflare Email Routing API 尚未配置。' },
    permission_denied: { status: 502, code: 'CLOUDFLARE_ROUTING_PERMISSION_DENIED', message: 'Cloudflare Token 缺少此 Zone 的 Email Routing 权限。' },
    rate_limited: { status: 503, code: 'CLOUDFLARE_ROUTING_RATE_LIMITED', message: 'Cloudflare Email Routing 请求过于频繁，请稍后重试。' },
    timeout: { status: 503, code: 'CLOUDFLARE_ROUTING_RESULT_UNKNOWN', message: 'Cloudflare 请求超时，规则状态需要重新检查。' },
    network_failure: { status: 503, code: 'CLOUDFLARE_ROUTING_UNAVAILABLE', message: 'Cloudflare Email Routing 暂时不可用。' },
    not_found: { status: 502, code: 'CLOUDFLARE_ROUTING_ZONE_NOT_FOUND', message: 'Cloudflare Zone 或 Routing Rule 不存在。' },
    invalid_response: { status: 502, code: 'CLOUDFLARE_ROUTING_INVALID_RESPONSE', message: 'Cloudflare Email Routing 返回了无法验证的响应。' },
    upstream_failed: { status: 503, code: 'CLOUDFLARE_ROUTING_UNAVAILABLE', message: 'Cloudflare Email Routing 暂时不可用。' },
    too_many_rules: { status: 503, code: 'CLOUDFLARE_RULE_LIST_TOO_LARGE', message: 'Cloudflare Zone 的规则列表超过了安全检查上限。' }
  };
  const mapped = mappings[error.code];
  return new ApiError(mapped.status, mapped.code, mapped.message, undefined, { reason: error.code }, error.retryable);
}

function validationApiError(error: MailIdentityValidationError): ApiError {
  const messages: Record<MailIdentityValidationError['code'], string> = {
    domain_invalid: '域名格式无效。',
    zone_id_invalid: 'Cloudflare Zone ID 格式无效。',
    worker_name_invalid: 'Worker 名称格式无效。',
    address_invalid: '邮件地址格式无效。',
    address_domain_mismatch: '邮件地址必须属于当前已配置域名。',
    address_too_long: 'Cloudflare Email Routing 的精确匹配地址最多支持 90 个字符。',
    display_name_too_long: '显示名称不能超过 128 个字符或包含换行。',
    signature_too_long: '签名不能超过 16 KiB。'
  };
  return new ApiError(400, 'MAIL_IDENTITY_INPUT_INVALID', messages[error.code], undefined, { reason: error.code }, false);
}

function operationConflict(reason: string, message = '邮件地址路由正在被另一个操作处理。') {
  return new ApiError(409, 'MAIL_ADDRESS_OPERATION_CONFLICT', message, undefined, { reason }, false);
}

function isRecipientMatcher(rule: CloudflareEmailRoutingRule, email: string) {
  return rule.matchers.length === 1 &&
    rule.matchers[0]?.type === 'literal' &&
    rule.matchers[0]?.field === 'to' &&
    rule.matchers[0]?.value?.toLowerCase() === email.toLowerCase();
}

function isCreatedByFlareMail(rule: CloudflareEmailRoutingRule, address: ManagedMailAddressRow) {
  return rule.source === 'api' &&
    rule.name === 'FlareMail managed address ' + address.id &&
    rule.enabled &&
    isRecipientMatcher(rule, address.email) &&
    rule.actions.length === 1 &&
    rule.actions[0]?.type === 'worker' &&
    rule.actions[0]?.value.length === 1;
}

function isExactConfiguredWorkerRule(rule: CloudflareEmailRoutingRule, address: ManagedMailAddressRow, workerName: string) {
  return isExactWorkerEmailRule(rule, address.email, workerName);
}

function ownedRuleForAddress(rule: CloudflareEmailRoutingRule, address: ManagedMailAddressRow, workerName: string) {
  if (!isExactConfiguredWorkerRule(rule, address, workerName)) return false;
  if (address.routing_owner === 'imported') {
    return rule.id === address.routing_rule_id && rule.source === address.routing_rule_source;
  }
  return isCreatedByFlareMail(rule, address);
}

async function markRoutingError(
  db: D1Database,
  addressId: string,
  ownerUserId: string,
  token: string,
  code: string,
  state: 'error' | 'unknown'
) {
  await db.prepare(
    'UPDATE mail_addresses SET routing_state = ?, receive_enabled = 0, last_error_code = ?, last_error_at = ?, ' +
    'operation_token = NULL, operation_expires_at = NULL, updated_at = ? ' +
    'WHERE id = ? AND owner_user_id = ? AND operation_token = ?'
  ).bind(state, code, isoNow(), isoNow(), addressId, ownerUserId, token).run();
}

async function acquireRoutingOperation(
  db: D1Database,
  address: ManagedMailAddressRow,
  ownerUserId: string,
  token: string,
  targetState: 'provisioning' | 'deleting'
) {
  const now = isoNow();
  const expiresAt = new Date(Date.now() + operationLeaseMs).toISOString();
  const allowed = targetState === 'deleting'
    ? "routing_state IN ('deleting', 'error', 'unknown', 'pending', 'provisioning', 'active', 'imported')"
    : "routing_state IN ('pending', 'provisioning', 'active', 'imported', 'unknown', 'error')";
  const result = await db.prepare(
    'UPDATE mail_addresses SET routing_state = ?, operation_token = ?, operation_expires_at = ?, ' +
    "receive_enabled = CASE WHEN lifecycle_status = 'active' THEN 0 ELSE receive_enabled END, updated_at = ? " +
    'WHERE id = ? AND owner_user_id = ? AND lifecycle_status != \'deleted\' AND ' + allowed + ' ' +
    'AND (operation_expires_at IS NULL OR operation_expires_at <= ?)'
  ).bind(targetState, token, expiresAt, now, address.id, ownerUserId, now).run();
  if (Number(result.meta?.changes ?? 0) === 1) return;

  const current = await getManagedMailAddress(db, ownerUserId, address.id);
  if (!current) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
  if (current.lifecycle_status === 'deleted' && targetState !== 'deleting') {
    throw new ApiError(409, 'MAIL_ADDRESS_DELETED', '已删除的邮件地址必须显式恢复后才能启用。', undefined, undefined, false);
  }
  if (current.operation_expires_at && current.operation_expires_at > now) {
    throw operationConflict('operation_in_progress');
  }
  throw operationConflict('state_conflict', '邮件地址当前状态不能执行此路由操作。');
}

async function routeProblem(
  db: D1Database,
  address: ManagedMailAddressRow,
  ownerUserId: string,
  token: string,
  code: string
): Promise<never> {
  await markRoutingError(db, address.id, ownerUserId, token, code, 'error');
  const message = code === 'cloudflare_exact_rule_conflict'
    ? '此地址已有其他 Cloudflare Routing Rule。请检查规则，或显式导入指向此 Worker 的规则。'
    : code === 'cloudflare_rule_changed'
      ? 'Cloudflare Rule 已被外部修改。FlareMail 没有改写或删除该规则。'
      : 'Cloudflare Routing Rule 与本地地址状态不一致。';
  throw new ApiError(409, 'CLOUDFLARE_ROUTING_CONFLICT', message, undefined, { reason: code }, false);
}

async function saveActiveRoute(
  db: D1Database,
  address: ManagedMailAddressRow,
  ownerUserId: string,
  token: string,
  rule: CloudflareEmailRoutingRule,
  routingOwner: 'flaremail' | 'imported',
  activateReceiving: boolean
) {
  if (!rule.source) throw new ApiError(502, 'CLOUDFLARE_RULE_SOURCE_UNKNOWN', 'Cloudflare Rule 来源无法确认。');
  const now = isoNow();
  const result = await db.prepare(
    "UPDATE mail_addresses SET routing_state = ?, routing_rule_id = ?, routing_rule_source = ?, routing_owner = ?, " +
    "receive_enabled = CASE WHEN lifecycle_status = 'active' AND ? = 1 THEN 1 ELSE 0 END, " +
    'last_error_code = NULL, last_error_at = NULL, operation_token = NULL, ' +
    'operation_expires_at = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ? AND operation_token = ? ' +
    "AND lifecycle_status != 'deleted'"
  ).bind(
    routingOwner === 'imported' ? 'imported' : 'active',
    rule.id,
    rule.source,
    routingOwner,
    activateReceiving ? 1 : 0,
    now,
    address.id,
    ownerUserId,
    token
  ).run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw operationConflict('operation_lost', '邮件地址已在操作期间改变状态。');
  }
  const updated = await getManagedMailAddress(db, ownerUserId, address.id);
  if (!updated) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
  return updated;
}

async function runRoutingOperation(
  env: CloudflareEnv,
  ownerUserId: string,
  addressId: string,
  activateReceiving: boolean
) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  const address = await getManagedMailAddress(env.DB, ownerUserId, addressId);
  if (!address) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
  if (address.lifecycle_status === 'deleted') {
    throw new ApiError(409, 'MAIL_ADDRESS_DELETED', '已删除的邮件地址必须显式恢复后才能启用。', undefined, undefined, false);
  }
  const domain = await getManagedMailDomain(env.DB, ownerUserId, address.domain_id);
  if (!domain || !domain.enabled) throw new ApiError(409, 'MAIL_DOMAIN_DISABLED', '此邮件域名未启用。', undefined, undefined, false);
  const token = crypto.randomUUID();
  await acquireRoutingOperation(env.DB, address, ownerUserId, token, 'provisioning');

  try {
    const client = cloudflareClient(env);
    const rules = await client.listRules(domain.cloudflare_zone_id);
    const exactRules = rules.filter((rule) => isRecipientMatcher(rule, address.email));
    if (exactRules.length > 1) {
      return await routeProblem(env.DB, address, ownerUserId, token, 'cloudflare_exact_rule_conflict');
    }
    if (exactRules.length === 1) {
      const existing = exactRules[0]!;
      if (!ownedRuleForAddress(existing, address, domain.worker_name)) {
        return await routeProblem(env.DB, address, ownerUserId, token, 'cloudflare_exact_rule_conflict');
      }
      const owner = address.routing_owner === 'imported' ? 'imported' : 'flaremail';
      return await saveActiveRoute(env.DB, address, ownerUserId, token, existing, owner, activateReceiving);
    }

    const created = await client.createWorkerRule(domain.cloudflare_zone_id, {
      email: address.email,
      workerName: domain.worker_name,
      addressId: address.id
    });
    if (!isExactConfiguredWorkerRule(created, address, domain.worker_name) ||
      created.source !== 'api' || created.name !== 'FlareMail managed address ' + address.id) {
      await markRoutingError(env.DB, address.id, ownerUserId, token, 'cloudflare_create_response_unverified', 'unknown');
      throw new ApiError(503, 'CLOUDFLARE_ROUTING_RESULT_UNKNOWN', 'Cloudflare 创建结果需要重新检查。');
    }
    const reconciled = (await client.listRules(domain.cloudflare_zone_id))
      .filter((rule) => isRecipientMatcher(rule, address.email));
    if (reconciled.length !== 1 || reconciled[0]?.id !== created.id) {
      await markRoutingError(env.DB, address.id, ownerUserId, token, 'cloudflare_create_duplicate_conflict', 'unknown');
      throw new ApiError(409, 'CLOUDFLARE_ROUTING_CONFLICT', '创建后发现多个同地址规则，已停止自动同步，请检查 Cloudflare Routing Rules。', undefined, { reason: 'duplicate_after_create' }, false);
    }
    return await saveActiveRoute(env.DB, address, ownerUserId, token, created, 'flaremail', activateReceiving);
  } catch (error) {
    if (error instanceof CloudflareEmailRoutingError) {
      const state = ['timeout', 'network_failure', 'upstream_failed'].includes(error.code) ? 'unknown' : 'error';
      await markRoutingError(env.DB, address.id, ownerUserId, token, 'cloudflare_' + error.code, state);
      throw cloudflareApiError(error);
    }
    if (error instanceof ApiError) throw error;
    throw error;
  }
}

export async function createManagedMailAddress(
  env: CloudflareEnv,
  ownerUserId: string,
  input: { domainId: string; address: string; displayName?: string; signature?: string }
) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  const domain = await getManagedMailDomain(env.DB, ownerUserId, input.domainId);
  if (!domain) throw new ApiError(404, 'MAIL_DOMAIN_NOT_FOUND', '已配置的邮件域名不存在。', undefined, undefined, false);
  if (!domain.enabled) throw new ApiError(409, 'MAIL_DOMAIN_DISABLED', '邮件域名未启用。', undefined, undefined, false);
  let normalized: { email: string; localPart: string };
  let displayName: string;
  let signature: string;
  try {
    normalized = normalizeManagedAddress(input.address, domain.domain_name);
    displayName = normalizeDisplayName(input.displayName ?? '');
    signature = normalizeAddressSignature(input.signature ?? '');
  } catch (error) {
    if (error instanceof MailIdentityValidationError) throw validationApiError(error);
    throw error;
  }

  const existing = await env.DB.prepare(
    'SELECT id, lifecycle_status FROM mail_addresses WHERE lower(email) = lower(?)'
  ).bind(normalized.email).first<{ id: string; lifecycle_status: string }>();
  if (existing) {
    if (existing.lifecycle_status === 'deleted') {
      throw new ApiError(409, 'MAIL_ADDRESS_RESTORE_REQUIRED', '此地址曾被显式删除。请使用恢复操作，而不是重新创建。', undefined, { reason: 'restore_required' }, false);
    }
    throw new ApiError(409, 'MAIL_ADDRESS_ALREADY_EXISTS', '此邮件地址已经存在。', undefined, undefined, false);
  }
  const id = crypto.randomUUID();
  const now = isoNow();
  try {
    await env.DB.prepare(
      "INSERT INTO mail_addresses (id, owner_user_id, domain_id, email, local_part, display_name, signature, " +
      "lifecycle_status, routing_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'pending', ?, ?)"
    ).bind(id, ownerUserId, domain.id, normalized.email, normalized.localPart, displayName, signature, now, now).run();
  } catch {
    throw new ApiError(409, 'MAIL_ADDRESS_ALREADY_EXISTS', '此邮件地址已经存在。', undefined, undefined, false);
  }
  return runRoutingOperation(env, ownerUserId, id, true);
}

export async function retryManagedMailAddressRoute(env: CloudflareEnv, ownerUserId: string, addressId: string) {
  return runRoutingOperation(env, ownerUserId, addressId, true);
}

export async function disableManagedMailAddress(env: CloudflareEnv, ownerUserId: string, addressId: string) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  const now = isoNow();
  const result = await env.DB.prepare(
    "UPDATE mail_addresses SET lifecycle_status = 'disabled', receive_enabled = 0, send_enabled = 0, " +
    'is_default_sender = 0, updated_at = ? WHERE id = ? AND owner_user_id = ? AND lifecycle_status != \'deleted\''
  ).bind(now, addressId, ownerUserId).run();
  if (Number(result.meta?.changes ?? 0) === 0) {
    const address = await getManagedMailAddress(env.DB, ownerUserId, addressId);
    if (!address) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
    throw new ApiError(409, 'MAIL_ADDRESS_DELETED', '已删除的邮件地址不能停用或重新启用。', undefined, undefined, false);
  }
  return getManagedMailAddress(env.DB, ownerUserId, addressId);
}

export async function enableManagedMailAddress(env: CloudflareEnv, ownerUserId: string, addressId: string) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  const now = isoNow();
  const result = await env.DB.prepare(
    "UPDATE mail_addresses SET lifecycle_status = 'active', receive_enabled = 0, updated_at = ? " +
    "WHERE id = ? AND owner_user_id = ? AND lifecycle_status = 'disabled'"
  ).bind(now, addressId, ownerUserId).run();
  if (Number(result.meta?.changes ?? 0) === 0) {
    const address = await getManagedMailAddress(env.DB, ownerUserId, addressId);
    if (!address) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
    throw new ApiError(409, 'MAIL_ADDRESS_NOT_DISABLED', '只有已停用地址可以重新启用。', undefined, undefined, false);
  }
  return runRoutingOperation(env, ownerUserId, addressId, true);
}

export async function restoreManagedMailAddress(env: CloudflareEnv, ownerUserId: string, addressId: string) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  const now = isoNow();
  const result = await env.DB.prepare(
    "UPDATE mail_addresses SET lifecycle_status = 'active', receive_enabled = 0, send_enabled = 0, " +
    "is_default_sender = 0, routing_state = CASE WHEN routing_rule_id IS NULL THEN 'pending' ELSE 'unknown' END, " +
    'operation_token = NULL, operation_expires_at = NULL, last_error_code = NULL, ' +
    'last_error_at = NULL, deleted_at = NULL, updated_at = ? ' +
    "WHERE id = ? AND owner_user_id = ? AND lifecycle_status = 'deleted'"
  ).bind(now, addressId, ownerUserId).run();
  if (Number(result.meta?.changes ?? 0) === 0) {
    const address = await getManagedMailAddress(env.DB, ownerUserId, addressId);
    if (!address) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
    throw new ApiError(409, 'MAIL_ADDRESS_NOT_DELETED', '此邮件地址当前并非删除状态。', undefined, undefined, false);
  }
  return getManagedMailAddress(env.DB, ownerUserId, addressId);
}

async function finishDeletedRoute(
  env: CloudflareEnv,
  ownerUserId: string,
  address: ManagedMailAddressRow,
  token: string,
  rule: CloudflareEmailRoutingRule | null,
  preserved = false
) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  const now = isoNow();
  const result = await env.DB.prepare(
    'UPDATE mail_addresses SET routing_state = ?, routing_rule_id = ?, routing_rule_source = ?, routing_owner = ?, ' +
    'receive_enabled = 0, send_enabled = 0, is_default_sender = 0, operation_token = NULL, ' +
    'operation_expires_at = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ? AND operation_token = ?'
  ).bind(
    preserved ? 'imported' : 'deleted',
    preserved ? address.routing_rule_id : null,
    preserved ? address.routing_rule_source : null,
    preserved ? 'imported' : null,
    now,
    address.id,
    ownerUserId,
    token
  ).run();
  if (Number(result.meta?.changes ?? 0) !== 1) throw operationConflict('operation_lost');
  return {
    address: await getManagedMailAddress(env.DB, ownerUserId, address.id),
    remoteRulePreserved: preserved || Boolean(rule && !isCreatedByFlareMail(rule, address))
  };
}

async function runDeleteOperation(env: CloudflareEnv, ownerUserId: string, addressId: string) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  const address = await getManagedMailAddress(env.DB, ownerUserId, addressId);
  if (!address) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
  if (address.lifecycle_status !== 'deleted') {
    const now = isoNow();
    const result = await env.DB.prepare(
      "UPDATE mail_addresses SET lifecycle_status = 'deleted', receive_enabled = 0, send_enabled = 0, " +
      'is_default_sender = 0, deleted_at = ?, routing_state = \'deleting\', updated_at = ? ' +
      'WHERE id = ? AND owner_user_id = ? AND lifecycle_status != \'deleted\''
    ).bind(now, now, address.id, ownerUserId).run();
    if (Number(result.meta?.changes ?? 0) !== 1) throw operationConflict('state_conflict');
  } else if (address.routing_state === 'deleted' || address.routing_state === 'imported') {
    return { address, remoteRulePreserved: address.routing_owner === 'imported' };
  }

  const current = await getManagedMailAddress(env.DB, ownerUserId, address.id);
  if (!current) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
  const token = crypto.randomUUID();
  const lockResult = await env.DB.prepare(
    "UPDATE mail_addresses SET routing_state = 'deleting', operation_token = ?, operation_expires_at = ?, updated_at = ? " +
    "WHERE id = ? AND owner_user_id = ? AND lifecycle_status = 'deleted' " +
    'AND (operation_expires_at IS NULL OR operation_expires_at <= ?)'
  ).bind(
    token,
    new Date(Date.now() + operationLeaseMs).toISOString(),
    isoNow(),
    address.id,
    ownerUserId,
    isoNow()
  ).run();
  if (Number(lockResult.meta?.changes ?? 0) !== 1) throw operationConflict('operation_in_progress');

  if (current.routing_owner === 'imported') {
    return finishDeletedRoute(env, ownerUserId, current, token, null, true);
  }
  try {
    const domain = await getManagedMailDomain(env.DB, ownerUserId, current.domain_id);
    if (!domain) throw new ApiError(404, 'MAIL_DOMAIN_NOT_FOUND', '已配置的邮件域名不存在。', undefined, undefined, false);
    const client = cloudflareClient(env);
    const rules = await client.listRules(domain.cloudflare_zone_id);
    const exactRules = rules.filter((rule) => isRecipientMatcher(rule, current.email));
    const ownedRules = exactRules.filter((rule) => isCreatedByFlareMail(rule, current));
    const target = current.routing_rule_id
      ? rules.find((rule) => rule.id === current.routing_rule_id) ?? ownedRules[0] ?? null
      : ownedRules[0] ?? null;
    if (!target) {
      if (exactRules.length) {
        await markRoutingError(env.DB, current.id, ownerUserId, token, 'cloudflare_external_rule_preserved', 'error');
        throw new ApiError(409, 'CLOUDFLARE_EXTERNAL_RULE_PRESERVED', '本地址的 Cloudflare Rule 不是 FlareMail 创建的规则，未修改远端配置。', undefined, { reason: 'external_rule_preserved' }, false);
      }
      return finishDeletedRoute(env, ownerUserId, current, token, null);
    }
    if (!isCreatedByFlareMail(target, current) || target.source !== 'api') {
      await markRoutingError(env.DB, current.id, ownerUserId, token, 'cloudflare_rule_changed', 'error');
      throw new ApiError(409, 'CLOUDFLARE_RULE_CHANGED', 'Cloudflare Rule 已被外部修改。FlareMail 没有删除该规则。', undefined, { reason: 'cloudflare_rule_changed' }, false);
    }
    await client.deleteRule(domain.cloudflare_zone_id, target.id);
    return finishDeletedRoute(env, ownerUserId, current, token, target);
  } catch (error) {
    if (error instanceof CloudflareEmailRoutingError) {
      const state = ['timeout', 'network_failure', 'upstream_failed'].includes(error.code) ? 'unknown' : 'error';
      await markRoutingError(env.DB, current.id, ownerUserId, token, 'cloudflare_' + error.code, state);
      throw cloudflareApiError(error);
    }
    if (error instanceof ApiError) throw error;
    throw error;
  }
}

export async function deleteManagedMailAddress(env: CloudflareEnv, ownerUserId: string, addressId: string) {
  return runDeleteOperation(env, ownerUserId, addressId);
}

export async function retryManagedMailAddress(env: CloudflareEnv, ownerUserId: string, addressId: string) {
  const address = env.DB ? await getManagedMailAddress(env.DB, ownerUserId, addressId) : null;
  if (!address) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
  if (address.lifecycle_status === 'deleted') return runDeleteOperation(env, ownerUserId, addressId);
  return runRoutingOperation(env, ownerUserId, addressId, address.lifecycle_status === 'active');
}

export async function importExistingWorkerRule(env: CloudflareEnv, ownerUserId: string, addressId: string) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  const address = await getManagedMailAddress(env.DB, ownerUserId, addressId);
  if (!address) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
  if (address.lifecycle_status === 'deleted') throw new ApiError(409, 'MAIL_ADDRESS_DELETED', '已删除的邮件地址必须显式恢复。', undefined, undefined, false);
  const domain = await getManagedMailDomain(env.DB, ownerUserId, address.domain_id);
  if (!domain) throw new ApiError(404, 'MAIL_DOMAIN_NOT_FOUND', '已配置的邮件域名不存在。', undefined, undefined, false);
  const token = crypto.randomUUID();
  await acquireRoutingOperation(env.DB, address, ownerUserId, token, 'provisioning');
  try {
    const rules = await cloudflareClient(env).listRules(domain.cloudflare_zone_id);
    const exactRules = rules.filter((rule) => isRecipientMatcher(rule, address.email));
    if (exactRules.length !== 1 || !isExactConfiguredWorkerRule(exactRules[0]!, address, domain.worker_name) || !exactRules[0]!.source) {
      return await routeProblem(env.DB, address, ownerUserId, token, 'cloudflare_exact_rule_conflict');
    }
    return await saveActiveRoute(env.DB, address, ownerUserId, token, exactRules[0]!, 'imported', address.lifecycle_status === 'active');
  } catch (error) {
    if (error instanceof CloudflareEmailRoutingError) {
      await markRoutingError(env.DB, address.id, ownerUserId, token, 'cloudflare_' + error.code, 'error');
      throw cloudflareApiError(error);
    }
    if (error instanceof ApiError) throw error;
    throw error;
  }
}
