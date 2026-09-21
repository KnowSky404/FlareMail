import type { CloudflareEnv } from '$lib/server/cloudflare';
import { getManagedMailAddress, getManagedMailDomain, type ManagedMailAddressRow } from '$lib/server/db/mail-identities';
import { ApiError } from '$lib/server/http/api';
import {
  CloudflareEmailRoutingClient,
  CloudflareEmailRoutingError,
  isExactRecipientRule,
  isExactWorkerEmailRule,
  isFlareMailManagedWorkerRule,
  type CloudflareEmailRoutingRule
} from '$lib/server/cloudflare-email-routing';
import {
  MailIdentityValidationError,
  normalizeAddressSignature,
  normalizeDisplayName,
  normalizeManagedAddress
} from './validation';

const operationLeaseMs = 5 * 60 * 1000;
type RoutingProviderClient = Pick<CloudflareEmailRoutingClient, 'listRules' | 'createWorkerRule' | 'deleteRule'>;

export interface MailIdentityRoutingDependencies {
  cloudflareClient?: (env: CloudflareEnv) => RoutingProviderClient;
  now?: () => Date;
  randomUUID?: () => string;
}

interface RoutingOperationOptions {
  token?: string;
  restoring?: boolean;
}

const defaultDependencies: Required<MailIdentityRoutingDependencies> = {
  cloudflareClient: (env) => cloudflareClient(env),
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID()
};

function currentTime(dependencies?: MailIdentityRoutingDependencies) {
  return (dependencies?.now ?? defaultDependencies.now)();
}

function isoNow(dependencies?: MailIdentityRoutingDependencies) {
  return currentTime(dependencies).toISOString();
}

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
  return isExactRecipientRule(rule, email);
}

function isCreatedByFlareMail(rule: CloudflareEmailRoutingRule, address: ManagedMailAddressRow, workerName: string) {
  return isFlareMailManagedWorkerRule(rule, {
    addressId: address.id,
    email: address.email,
    workerName,
    ruleId: address.routing_rule_id
  });
}

function isExactConfiguredWorkerRule(rule: CloudflareEmailRoutingRule, address: ManagedMailAddressRow, workerName: string) {
  return isExactWorkerEmailRule(rule, address.email, workerName);
}

function ownedRuleForAddress(rule: CloudflareEmailRoutingRule, address: ManagedMailAddressRow, workerName: string) {
  if (address.routing_owner === 'imported') {
    return isExactConfiguredWorkerRule(rule, address, workerName) &&
      rule.id === address.routing_rule_id && rule.source === address.routing_rule_source;
  }
  return isCreatedByFlareMail(rule, address, workerName);
}

async function markRoutingError(
  db: D1Database,
  addressId: string,
  ownerUserId: string,
  token: string,
  code: string,
  state: 'error' | 'unknown',
  dependencies?: MailIdentityRoutingDependencies,
  disableReceiving = false
) {
  const now = isoNow(dependencies);
  await db.prepare(
    'UPDATE mail_addresses SET routing_state = ?, receive_enabled = CASE WHEN ? = 1 THEN 0 ELSE receive_enabled END, ' +
    'last_error_code = ?, last_error_at = ?, ' +
    'operation_token = NULL, operation_expires_at = NULL, updated_at = ? ' +
    'WHERE id = ? AND owner_user_id = ? AND operation_token = ? AND operation_expires_at > ?'
  ).bind(state, disableReceiving ? 1 : 0, code, now, now, addressId, ownerUserId, token, now).run();
}

async function acquireRoutingOperation(
  db: D1Database,
  address: ManagedMailAddressRow,
  ownerUserId: string,
  token: string,
  targetState: 'provisioning' | 'deleting',
  dependencies?: MailIdentityRoutingDependencies
) {
  const timestamp = currentTime(dependencies);
  const now = timestamp.toISOString();
  const expiresAt = new Date(timestamp.getTime() + operationLeaseMs).toISOString();
  const allowed = targetState === 'deleting'
    ? "routing_state IN ('deleting', 'error', 'unknown', 'pending', 'provisioning', 'active', 'imported')"
    : "routing_state IN ('pending', 'provisioning', 'active', 'imported', 'unknown', 'error')";
  const result = await db.prepare(
    'UPDATE mail_addresses SET routing_state = ?, operation_token = ?, operation_expires_at = ?, ' +
    'updated_at = ? ' +
    'WHERE id = ? AND owner_user_id = ? AND lifecycle_status != \'deleted\' AND ' + allowed + ' ' +
    'AND (operation_token IS NULL OR operation_expires_at <= ?)'
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

async function assertOperationLease(
  db: D1Database,
  addressId: string,
  ownerUserId: string,
  token: string,
  allowDeleted: boolean,
  dependencies?: MailIdentityRoutingDependencies
) {
  const row = await db.prepare(
    'SELECT 1 AS found FROM mail_addresses WHERE id = ? AND owner_user_id = ? AND operation_token = ? ' +
    'AND operation_expires_at > ? AND (lifecycle_status != \'deleted\' OR ? = 1) LIMIT 1'
  ).bind(addressId, ownerUserId, token, isoNow(dependencies), allowDeleted ? 1 : 0).first<{ found: number }>();
  if (!row) throw operationConflict('operation_lost', '邮件地址操作租约已失效，请重新检查后再试。');
}

async function routeProblem(
  db: D1Database,
  address: ManagedMailAddressRow,
  ownerUserId: string,
  token: string,
  code: string,
  dependencies?: MailIdentityRoutingDependencies
): Promise<never> {
  await markRoutingError(db, address.id, ownerUserId, token, code, 'error', dependencies, true);
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
  activateReceiving: boolean,
  dependencies?: MailIdentityRoutingDependencies,
  restoring = false
) {
  if (!rule.source) throw new ApiError(502, 'CLOUDFLARE_RULE_SOURCE_UNKNOWN', 'Cloudflare Rule 来源无法确认。');
  const now = isoNow(dependencies);
  const canReceive = activateReceiving && (address.lifecycle_status === 'active' || restoring);
  const result = await db.prepare(
    "UPDATE mail_addresses SET lifecycle_status = CASE WHEN ? = 1 THEN 'active' ELSE lifecycle_status END, " +
    'deleted_at = CASE WHEN ? = 1 THEN NULL ELSE deleted_at END, ' +
    'routing_state = ?, routing_rule_id = ?, routing_rule_source = ?, routing_owner = ?, ' +
    'receive_enabled = CASE WHEN ? = 1 THEN 1 ELSE 0 END, ' +
    'last_error_code = NULL, last_error_at = NULL, operation_token = NULL, ' +
    'operation_expires_at = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ? AND operation_token = ? ' +
    'AND operation_expires_at > ? AND (lifecycle_status != \'deleted\' OR ? = 1)'
  ).bind(
    restoring ? 1 : 0,
    restoring ? 1 : 0,
    routingOwner === 'imported' ? 'imported' : 'active',
    rule.id,
    rule.source,
    routingOwner,
    canReceive ? 1 : 0,
    now,
    address.id,
    ownerUserId,
    token,
    now,
    restoring ? 1 : 0
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
  activateReceiving: boolean,
  dependencies?: MailIdentityRoutingDependencies,
  options: RoutingOperationOptions = {}
) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  const address = await getManagedMailAddress(env.DB, ownerUserId, addressId);
  if (!address) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
  if (address.lifecycle_status === 'deleted' && !options.restoring) {
    throw new ApiError(409, 'MAIL_ADDRESS_DELETED', '已删除的邮件地址必须显式恢复后才能启用。', undefined, undefined, false);
  }
  if (options.token && address.operation_token !== options.token) throw operationConflict('operation_lost');
  const domain = await getManagedMailDomain(env.DB, ownerUserId, address.domain_id);
  if (!domain || !domain.enabled) {
    if (options.token) await markRoutingError(env.DB, address.id, ownerUserId, options.token, 'mail_domain_disabled', 'error', dependencies);
    throw new ApiError(409, 'MAIL_DOMAIN_DISABLED', '此邮件域名未启用。', undefined, undefined, false);
  }
  const token = options.token ?? (dependencies?.randomUUID ?? defaultDependencies.randomUUID)();
  if (!options.token) await acquireRoutingOperation(env.DB, address, ownerUserId, token, 'provisioning', dependencies);

  try {
    await assertOperationLease(env.DB, address.id, ownerUserId, token, options.restoring === true, dependencies);
    const client = (dependencies?.cloudflareClient ?? defaultDependencies.cloudflareClient)(env);
    const rules = await client.listRules(domain.cloudflare_zone_id);
    const exactRules = rules.filter((rule) => isRecipientMatcher(rule, address.email));
    if (exactRules.length > 1) {
      return await routeProblem(env.DB, address, ownerUserId, token, 'cloudflare_exact_rule_conflict', dependencies);
    }
    if (exactRules.length === 1) {
      const existing = exactRules[0]!;
      if (!ownedRuleForAddress(existing, address, domain.worker_name)) {
        return await routeProblem(env.DB, address, ownerUserId, token, 'cloudflare_exact_rule_conflict', dependencies);
      }
      const owner = address.routing_owner === 'imported' ? 'imported' : 'flaremail';
      return await saveActiveRoute(env.DB, address, ownerUserId, token, existing, owner, activateReceiving, dependencies, options.restoring);
    }

    if (address.routing_owner === 'imported') {
      return await routeProblem(env.DB, address, ownerUserId, token, 'cloudflare_rule_changed', dependencies);
    }
    await assertOperationLease(env.DB, address.id, ownerUserId, token, options.restoring === true, dependencies);
    const created = await client.createWorkerRule(domain.cloudflare_zone_id, {
      email: address.email,
      workerName: domain.worker_name,
      addressId: address.id
    });
    if (!isCreatedByFlareMail(created, address, domain.worker_name)) {
      await markRoutingError(env.DB, address.id, ownerUserId, token, 'cloudflare_create_response_unverified', 'unknown', dependencies);
      throw new ApiError(503, 'CLOUDFLARE_ROUTING_RESULT_UNKNOWN', 'Cloudflare 创建结果需要重新检查。');
    }
    const reconciled = (await client.listRules(domain.cloudflare_zone_id))
      .filter((rule) => isRecipientMatcher(rule, address.email));
    if (reconciled.length !== 1 || reconciled[0]?.id !== created.id ||
      !isCreatedByFlareMail(reconciled[0]!, address, domain.worker_name)) {
      await markRoutingError(env.DB, address.id, ownerUserId, token, 'cloudflare_create_duplicate_conflict', 'unknown', dependencies);
      throw new ApiError(409, 'CLOUDFLARE_ROUTING_CONFLICT', '创建后发现多个同地址规则，已停止自动同步，请检查 Cloudflare Routing Rules。', undefined, { reason: 'duplicate_after_create' }, false);
    }
    return await saveActiveRoute(env.DB, address, ownerUserId, token, reconciled[0]!, 'flaremail', activateReceiving, dependencies, options.restoring);
  } catch (error) {
    if (error instanceof CloudflareEmailRoutingError) {
      const state = ['timeout', 'network_failure', 'upstream_failed'].includes(error.code) ? 'unknown' : 'error';
      await markRoutingError(env.DB, address.id, ownerUserId, token, 'cloudflare_' + error.code, state, dependencies);
      throw cloudflareApiError(error);
    }
    if (error instanceof ApiError) throw error;
    throw error;
  }
}

export async function createManagedMailAddress(
  env: CloudflareEnv,
  ownerUserId: string,
  input: { domainId: string; address: string; displayName?: string; signature?: string },
  dependencies?: MailIdentityRoutingDependencies
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
  const id = (dependencies?.randomUUID ?? defaultDependencies.randomUUID)();
  const now = isoNow(dependencies);
  try {
    await env.DB.prepare(
      "INSERT INTO mail_addresses (id, owner_user_id, domain_id, email, local_part, display_name, signature, " +
      "lifecycle_status, routing_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'pending', ?, ?)"
    ).bind(id, ownerUserId, domain.id, normalized.email, normalized.localPart, displayName, signature, now, now).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unique constraint failed:\s*mail_addresses\.email|mail_addresses\.email.*unique/iu.test(message)) {
      throw new ApiError(409, 'MAIL_ADDRESS_ALREADY_EXISTS', '此邮件地址已经存在。', undefined, undefined, false);
    }
    throw new ApiError(503, 'D1_WRITE_FAILED', '邮件地址暂时无法保存，请稍后重试。', undefined, { reason: 'mail_address_insert_failed' }, true);
  }
  return runRoutingOperation(env, ownerUserId, id, true, dependencies);
}

export async function retryManagedMailAddressRoute(
  env: CloudflareEnv,
  ownerUserId: string,
  addressId: string,
  dependencies?: MailIdentityRoutingDependencies
) {
  return runRoutingOperation(env, ownerUserId, addressId, true, dependencies);
}

export async function disableManagedMailAddress(
  env: CloudflareEnv,
  ownerUserId: string,
  addressId: string,
  dependencies?: MailIdentityRoutingDependencies
) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  const now = isoNow(dependencies);
  const result = await env.DB.prepare(
    "UPDATE mail_addresses SET lifecycle_status = 'disabled', receive_enabled = 0, send_enabled = 0, " +
    "is_default_sender = 0, routing_state = CASE WHEN routing_state = 'provisioning' THEN 'unknown' ELSE routing_state END, " +
    'operation_token = NULL, operation_expires_at = NULL, updated_at = ? ' +
    'WHERE id = ? AND owner_user_id = ? AND lifecycle_status != \'deleted\' ' +
    'AND (operation_token IS NULL OR operation_expires_at <= ?)'
  ).bind(now, addressId, ownerUserId, now).run();
  if (Number(result.meta?.changes ?? 0) === 0) {
    const address = await getManagedMailAddress(env.DB, ownerUserId, addressId);
    if (!address) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
    if (address.operation_token && address.operation_expires_at && address.operation_expires_at > now) {
      throw operationConflict('operation_in_progress');
    }
    if (address.lifecycle_status === 'disabled') return address;
    throw new ApiError(409, 'MAIL_ADDRESS_DELETED', '已删除的邮件地址不能停用或重新启用。', undefined, undefined, false);
  }
  return getManagedMailAddress(env.DB, ownerUserId, addressId);
}

export async function enableManagedMailAddress(
  env: CloudflareEnv,
  ownerUserId: string,
  addressId: string,
  dependencies?: MailIdentityRoutingDependencies
) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  const timestamp = currentTime(dependencies);
  const now = timestamp.toISOString();
  const token = (dependencies?.randomUUID ?? defaultDependencies.randomUUID)();
  const result = await env.DB.prepare(
    "UPDATE mail_addresses SET lifecycle_status = 'active', receive_enabled = 0, routing_state = 'provisioning', " +
    'operation_token = ?, operation_expires_at = ?, updated_at = ? ' +
    "WHERE id = ? AND owner_user_id = ? AND lifecycle_status = 'disabled' " +
    'AND (operation_token IS NULL OR operation_expires_at <= ?)'
  ).bind(token, new Date(timestamp.getTime() + operationLeaseMs).toISOString(), now, addressId, ownerUserId, now).run();
  if (Number(result.meta?.changes ?? 0) === 0) {
    const address = await getManagedMailAddress(env.DB, ownerUserId, addressId);
    if (!address) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
    if (address.operation_token && address.operation_expires_at && address.operation_expires_at > now) {
      throw operationConflict('operation_in_progress');
    }
    throw new ApiError(409, 'MAIL_ADDRESS_NOT_DISABLED', '只有已停用地址可以重新启用。', undefined, undefined, false);
  }
  return runRoutingOperation(env, ownerUserId, addressId, true, dependencies, { token });
}

export async function restoreManagedMailAddress(
  env: CloudflareEnv,
  ownerUserId: string,
  addressId: string,
  dependencies?: MailIdentityRoutingDependencies
) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  const timestamp = currentTime(dependencies);
  const now = timestamp.toISOString();
  const token = (dependencies?.randomUUID ?? defaultDependencies.randomUUID)();
  const result = await env.DB.prepare(
    "UPDATE mail_addresses SET receive_enabled = 0, send_enabled = 0, is_default_sender = 0, " +
    "routing_state = 'provisioning', operation_token = ?, operation_expires_at = ?, " +
    'last_error_code = NULL, last_error_at = NULL, updated_at = ? ' +
    "WHERE id = ? AND owner_user_id = ? AND lifecycle_status = 'deleted' " +
    "AND routing_state IN ('deleted', 'imported') " +
    'AND (operation_token IS NULL OR operation_expires_at <= ?)'
  ).bind(
    token,
    new Date(timestamp.getTime() + operationLeaseMs).toISOString(),
    now,
    addressId,
    ownerUserId,
    now
  ).run();
  if (Number(result.meta?.changes ?? 0) === 0) {
    const address = await getManagedMailAddress(env.DB, ownerUserId, addressId);
    if (!address) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
    if (address.operation_token && address.operation_expires_at && address.operation_expires_at > now) {
      throw operationConflict('operation_in_progress', '删除或检查尚未确认完成，请先重试该操作。');
    }
    if (address.lifecycle_status !== 'deleted') {
      throw new ApiError(409, 'MAIL_ADDRESS_NOT_DELETED', '此邮件地址当前并非删除状态。', undefined, undefined, false);
    }
    throw operationConflict('delete_not_reconciled', '请先重试删除以确认 Cloudflare 状态，再恢复此地址。');
  }
  return runRoutingOperation(env, ownerUserId, addressId, true, dependencies, { token, restoring: true });
}

async function finishDeletedRoute(
  env: CloudflareEnv,
  ownerUserId: string,
  address: ManagedMailAddressRow,
  token: string,
  rule: CloudflareEmailRoutingRule | null,
  preserved = false,
  workerName: string,
  dependencies?: MailIdentityRoutingDependencies
) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  const now = isoNow(dependencies);
  const result = await env.DB.prepare(
    'UPDATE mail_addresses SET routing_state = ?, routing_rule_id = ?, routing_rule_source = ?, routing_owner = ?, ' +
    'receive_enabled = 0, send_enabled = 0, is_default_sender = 0, last_error_code = NULL, last_error_at = NULL, operation_token = NULL, ' +
    'operation_expires_at = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ? AND operation_token = ? ' +
    'AND operation_expires_at > ?'
  ).bind(
    preserved ? 'imported' : 'deleted',
    preserved ? address.routing_rule_id : null,
    preserved ? address.routing_rule_source : null,
    preserved ? 'imported' : null,
    now,
    address.id,
    ownerUserId,
    token,
    now
  ).run();
  if (Number(result.meta?.changes ?? 0) !== 1) throw operationConflict('operation_lost');
  return {
    address: await getManagedMailAddress(env.DB, ownerUserId, address.id),
    remoteRulePreserved: preserved || Boolean(rule && !isCreatedByFlareMail(rule, address, workerName))
  };
}

async function runDeleteOperation(
  env: CloudflareEnv,
  ownerUserId: string,
  addressId: string,
  dependencies?: MailIdentityRoutingDependencies
) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  const address = await getManagedMailAddress(env.DB, ownerUserId, addressId);
  if (!address) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
  if (address.lifecycle_status === 'deleted' && ['deleted', 'imported'].includes(address.routing_state)) {
    return { address, remoteRulePreserved: address.routing_owner === 'imported' };
  }

  const timestamp = currentTime(dependencies);
  const now = timestamp.toISOString();
  const token = (dependencies?.randomUUID ?? defaultDependencies.randomUUID)();
  const lockResult = await env.DB.prepare(
    "UPDATE mail_addresses SET lifecycle_status = 'deleted', receive_enabled = 0, send_enabled = 0, " +
    'is_default_sender = 0, deleted_at = COALESCE(deleted_at, ?), routing_state = \'deleting\', ' +
    'operation_token = ?, operation_expires_at = ?, updated_at = ? ' +
    'WHERE id = ? AND owner_user_id = ? AND (operation_token IS NULL OR operation_expires_at <= ?) ' +
    "AND (lifecycle_status != 'deleted' OR routing_state NOT IN ('deleted', 'imported'))"
  ).bind(
    now,
    token,
    new Date(timestamp.getTime() + operationLeaseMs).toISOString(),
    now,
    address.id,
    ownerUserId,
    now
  ).run();
  if (Number(lockResult.meta?.changes ?? 0) !== 1) {
    const current = await getManagedMailAddress(env.DB, ownerUserId, address.id);
    if (!current) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
    if (current.lifecycle_status === 'deleted' && ['deleted', 'imported'].includes(current.routing_state)) {
      return { address: current, remoteRulePreserved: current.routing_owner === 'imported' };
    }
    throw operationConflict('operation_in_progress');
  }

  const current = await getManagedMailAddress(env.DB, ownerUserId, address.id);
  if (!current) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
  const domain = await getManagedMailDomain(env.DB, ownerUserId, current.domain_id);
  if (!domain) {
    await markRoutingError(env.DB, current.id, ownerUserId, token, 'mail_domain_missing', 'error', dependencies);
    throw new ApiError(404, 'MAIL_DOMAIN_NOT_FOUND', '已配置的邮件域名不存在。', undefined, undefined, false);
  }
  if (current.routing_owner === 'imported') {
    return finishDeletedRoute(env, ownerUserId, current, token, null, true, domain.worker_name, dependencies);
  }
  try {
    const client = (dependencies?.cloudflareClient ?? defaultDependencies.cloudflareClient)(env);
    await assertOperationLease(env.DB, current.id, ownerUserId, token, true, dependencies);
    const rules = await client.listRules(domain.cloudflare_zone_id);
    const exactRules = rules.filter((rule) => isRecipientMatcher(rule, current.email));
    const markedRules = rules.filter((rule) =>
      rule.source === 'api' && rule.name === 'FlareMail managed address ' + current.id
    );
    let target: CloudflareEmailRoutingRule | null = null;
    if (current.routing_rule_id) {
      target = rules.find((rule) => rule.id === current.routing_rule_id) ?? null;
    } else if (markedRules.length === 1) {
      target = markedRules[0]!;
    }

    if (!target) {
      if (exactRules.length || markedRules.length > 1) {
        await markRoutingError(env.DB, current.id, ownerUserId, token, 'cloudflare_external_rule_preserved', 'error', dependencies);
        throw new ApiError(409, 'CLOUDFLARE_EXTERNAL_RULE_PRESERVED', '本地址的 Cloudflare Rule 不是 FlareMail 创建的规则，未修改远端配置。', undefined, { reason: 'external_rule_preserved' }, false);
      }
      return finishDeletedRoute(env, ownerUserId, current, token, null, false, domain.worker_name, dependencies);
    }

    const exactFingerprint = isCreatedByFlareMail(target, current, domain.worker_name);
    if (!exactFingerprint || exactRules.length !== 1 || exactRules[0]?.id !== target.id ||
      (!current.routing_rule_id && markedRules.length !== 1)) {
      await markRoutingError(env.DB, current.id, ownerUserId, token, 'cloudflare_rule_changed', 'error', dependencies);
      throw new ApiError(409, 'CLOUDFLARE_RULE_CHANGED', 'Cloudflare Rule 已被外部修改。FlareMail 没有删除该规则。', undefined, { reason: 'cloudflare_rule_changed' }, false);
    }

    // Cloudflare's DELETE endpoint accepts an ID but documents no ETag or
    // version precondition. Re-read the full zone immediately before DELETE.
    await assertOperationLease(env.DB, current.id, ownerUserId, token, true, dependencies);
    const beforeDelete = await client.listRules(domain.cloudflare_zone_id);
    const latestTarget = beforeDelete.find((rule) => rule.id === target!.id);
    const latestExact = beforeDelete.filter((rule) => isRecipientMatcher(rule, current.email));
    if (!latestTarget && latestExact.length === 0) {
      return finishDeletedRoute(env, ownerUserId, current, token, null, false, domain.worker_name, dependencies);
    }
    if (!latestTarget || latestExact.length !== 1 || latestExact[0]?.id !== target.id ||
      !isCreatedByFlareMail(latestTarget, current, domain.worker_name)) {
      await markRoutingError(env.DB, current.id, ownerUserId, token, 'cloudflare_rule_changed', 'error', dependencies);
      throw new ApiError(409, 'CLOUDFLARE_RULE_CHANGED', 'Cloudflare Rule 已在删除前发生变化。FlareMail 保留了远端规则。', undefined, { reason: 'cloudflare_rule_changed' }, false);
    }

    let deleteError: unknown = null;
    try {
      await assertOperationLease(env.DB, current.id, ownerUserId, token, true, dependencies);
      await client.deleteRule(domain.cloudflare_zone_id, latestTarget.id);
    } catch (error) {
      deleteError = error;
    }

    let afterDelete: CloudflareEmailRoutingRule[];
    try {
      afterDelete = await client.listRules(domain.cloudflare_zone_id);
    } catch {
      await markRoutingError(env.DB, current.id, ownerUserId, token, 'cloudflare_delete_result_unknown', 'unknown', dependencies);
      throw new ApiError(503, 'CLOUDFLARE_ROUTING_RESULT_UNKNOWN', 'Cloudflare 删除结果暂时无法确认。请重新检查后再重试。', undefined, { reason: 'delete_result_unknown' }, true);
    }
    const stillById = afterDelete.find((rule) => rule.id === latestTarget.id);
    const stillExact = afterDelete.filter((rule) => isRecipientMatcher(rule, current.email));
    if (!stillById && stillExact.length === 0) {
      return finishDeletedRoute(env, ownerUserId, current, token, latestTarget, false, domain.worker_name, dependencies);
    }
    if (!stillById || stillExact.length !== 1 || stillExact[0]?.id !== latestTarget.id ||
      !isCreatedByFlareMail(stillById, current, domain.worker_name)) {
      await markRoutingError(env.DB, current.id, ownerUserId, token, 'cloudflare_delete_conflict', 'error', dependencies);
      throw new ApiError(409, 'CLOUDFLARE_RULE_CHANGED', '删除后发现远端规则状态发生变化；FlareMail 保留了现有规则。', undefined, { reason: 'delete_reconcile_conflict' }, false);
    }
    await markRoutingError(env.DB, current.id, ownerUserId, token, 'cloudflare_delete_not_confirmed', 'unknown', dependencies);
    if (deleteError instanceof CloudflareEmailRoutingError && deleteError.code !== 'not_found') {
      throw cloudflareApiError(deleteError);
    }
    throw new ApiError(503, 'CLOUDFLARE_ROUTING_RESULT_UNKNOWN', 'Cloudflare 尚未确认删除此规则。请检查状态后再重试。', undefined, { reason: 'delete_not_confirmed' }, true);
  } catch (error) {
    if (error instanceof CloudflareEmailRoutingError) {
      const state = ['timeout', 'network_failure', 'upstream_failed'].includes(error.code) ? 'unknown' : 'error';
      await markRoutingError(env.DB, current.id, ownerUserId, token, 'cloudflare_' + error.code, state, dependencies);
      throw cloudflareApiError(error);
    }
    if (error instanceof ApiError) throw error;
    throw error;
  }
}

export async function deleteManagedMailAddress(
  env: CloudflareEnv,
  ownerUserId: string,
  addressId: string,
  dependencies?: MailIdentityRoutingDependencies
) {
  return runDeleteOperation(env, ownerUserId, addressId, dependencies);
}

export async function retryManagedMailAddress(
  env: CloudflareEnv,
  ownerUserId: string,
  addressId: string,
  dependencies?: MailIdentityRoutingDependencies
) {
  const address = env.DB ? await getManagedMailAddress(env.DB, ownerUserId, addressId) : null;
  if (!address) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
  if (address.lifecycle_status === 'deleted') return runDeleteOperation(env, ownerUserId, addressId, dependencies);
  return runRoutingOperation(env, ownerUserId, addressId, address.lifecycle_status === 'active', dependencies);
}

export async function importExistingWorkerRule(
  env: CloudflareEnv,
  ownerUserId: string,
  addressId: string,
  dependencies?: MailIdentityRoutingDependencies
) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  const address = await getManagedMailAddress(env.DB, ownerUserId, addressId);
  if (!address) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
  if (address.lifecycle_status === 'deleted') throw new ApiError(409, 'MAIL_ADDRESS_DELETED', '已删除的邮件地址必须显式恢复。', undefined, undefined, false);
  const domain = await getManagedMailDomain(env.DB, ownerUserId, address.domain_id);
  if (!domain) throw new ApiError(404, 'MAIL_DOMAIN_NOT_FOUND', '已配置的邮件域名不存在。', undefined, undefined, false);
  if (!domain.enabled) throw new ApiError(409, 'MAIL_DOMAIN_DISABLED', '邮件域名未启用。', undefined, undefined, false);
  const token = (dependencies?.randomUUID ?? defaultDependencies.randomUUID)();
  await acquireRoutingOperation(env.DB, address, ownerUserId, token, 'provisioning', dependencies);
  try {
    const rules = await (dependencies?.cloudflareClient ?? defaultDependencies.cloudflareClient)(env).listRules(domain.cloudflare_zone_id);
    const exactRules = rules.filter((rule) => isRecipientMatcher(rule, address.email));
    if (exactRules.length !== 1 || !isExactConfiguredWorkerRule(exactRules[0]!, address, domain.worker_name) || !exactRules[0]!.source) {
      return await routeProblem(env.DB, address, ownerUserId, token, 'cloudflare_exact_rule_conflict', dependencies);
    }
    return await saveActiveRoute(env.DB, address, ownerUserId, token, exactRules[0]!, 'imported', address.lifecycle_status === 'active', dependencies);
  } catch (error) {
    if (error instanceof CloudflareEmailRoutingError) {
      await markRoutingError(env.DB, address.id, ownerUserId, token, 'cloudflare_' + error.code, 'error', dependencies);
      throw cloudflareApiError(error);
    }
    if (error instanceof ApiError) throw error;
    throw error;
  }
}
