import type { CloudflareEnv } from '$lib/server/cloudflare';
import { ApiError } from '$lib/server/http/api';
import { getManagedMailAddress } from '$lib/server/db/mail-identities';
import { normalizePreInboundRecipient, resolvePreInboundMatch } from '$lib/server/inbound/pre-inbound';
import {
  claimInboundRoutingOwner,
  findInboundRoutingOwner,
  inboundRoutingKey,
  readInboundRouting,
  type InboundRoutingKind
} from '$lib/server/inbound/routing-ownership';

export function isStandaloneFixedPreview(env: CloudflareEnv) {
  return env.PRE_INBOUND_SETTINGS?.previewApp === true && !readInboundRouting(env);
}

export function isMailRoutingReadOnly(env: CloudflareEnv) {
  return env.INBOUND_ROUTING_SCOPE?.readOnly === true || isStandaloneFixedPreview(env);
}

export function isPreviewRoutingReadOnly(env: CloudflareEnv) {
  return env.INBOUND_ROUTING_SCOPE?.environment !== 'production' && isMailRoutingReadOnly(env);
}

export function hasProductionCatchAllObserver(
  env: CloudflareEnv, domain: { enabled: number; unknown_recipient_policy: 'reject' | 'collect' }
) {
  return env.INBOUND_ROUTING_SCOPE?.environment === 'preview' && domain.enabled === 1 &&
    domain.unknown_recipient_policy === 'collect';
}

export function requireMailRoutingWrites(env: CloudflareEnv) {
  if (env.INBOUND_ROUTING_SCOPE?.readOnly === true) {
    if (env.INBOUND_ROUTING_SCOPE.environment === 'production') {
      throw new ApiError(403, 'MAIL_ROUTING_CUTOVER_READ_ONLY', '收信切换期间的邮件身份配置为只读。', undefined, undefined, false);
    }
    throw new ApiError(403, 'MAIL_ROUTING_PREVIEW_READ_ONLY', 'PRE 验收期间的邮件身份配置为只读。', undefined, undefined, false);
  }
  if (isStandaloneFixedPreview(env)) {
    throw new ApiError(403, 'MAIL_ROUTING_FIXED_PRE_READ_ONLY', '固定地址 PRE 的邮件身份配置为只读。', undefined, undefined, false);
  }
}

function conflictsWithFixedPreviewReservation(env: CloudflareEnv, kind: InboundRoutingKind, value: string) {
  const recipient = env.PRE_INBOUND_SETTINGS?.recipient;
  if (kind !== 'mailbox' || typeof recipient !== 'string') return false;
  const match = resolvePreInboundMatch(normalizePreInboundRecipient(recipient), value);
  if (isStandaloneFixedPreview(env)) return match !== 'exact';
  return match === 'subaddress' || (match === 'exact' && readInboundRouting(env)?.environment !== 'preview');
}

export async function filterOwnedMailboxes<T extends { email: string }>(env: CloudflareEnv, mailboxes: T[]) {
  const eligible = mailboxes.filter(({ email }) => !conflictsWithFixedPreviewReservation(env, 'mailbox', email));
  const routing = readInboundRouting(env);
  if (!routing || !eligible.length) return eligible;
  const keys = [...new Set(eligible.map(({ email }) => inboundRoutingKey('mailbox', email)))];
  const owned = new Set<string>();
  for (let offset = 0; offset < keys.length; offset += 200) {
    const { results } = await routing.db.prepare(`SELECT route_key FROM inbound_routing_ownership
      WHERE kind = 'mailbox' AND environment = ? AND route_key IN (SELECT value FROM json_each(?))`)
      .bind(routing.environment, JSON.stringify(keys.slice(offset, offset + 200))).all<{ route_key: string }>();
    for (const { route_key } of results) owned.add(route_key);
  }
  return eligible.filter(({ email }) => owned.has(inboundRoutingKey('mailbox', email)));
}

export async function ownsMailRouting(env: CloudflareEnv, kind: InboundRoutingKind, value: string) {
  if (conflictsWithFixedPreviewReservation(env, kind, value)) return false;
  const routing = readInboundRouting(env);
  return !routing || await findInboundRoutingOwner(routing.db, kind, value) === routing.environment;
}

export async function catchAllOwnershipError(env: CloudflareEnv, domain: string) {
  const routing = readInboundRouting(env);
  if (!routing) return null;
  const owner = await findInboundRoutingOwner(routing.db, 'catch_all', domain);
  if (!owner) return 'cloudflare_collect_catch_all_unassigned';
  return owner !== routing.environment ? 'cloudflare_collect_catch_all_owned_elsewhere' : null;
}

export function hasWorkerMappingConflict(env: CloudflareEnv, workerName: string) {
  const scope = env.INBOUND_ROUTING_SCOPE;
  const expected = scope?.workerName ?? env.MAIL_IDENTITY_WORKER_NAME?.trim();
  return Boolean(scope && expected && expected !== workerName);
}

export function workerMappingConflict() {
  return new ApiError(409, 'MAIL_DOMAIN_WORKER_MAPPING_CONFLICT', '此邮件域名仍指向其他 Worker，请先核对并更新域名映射。', undefined, undefined, false);
}

export function ownershipConflict() {
  return new ApiError(409, 'MAIL_ROUTING_OWNERSHIP_CONFLICT', '该收信地址或兜底规则未归属当前环境。', undefined, undefined, false);
}

export async function requireMailRoutingOwnership(env: CloudflareEnv, kind: InboundRoutingKind, value: string) {
  requireMailRoutingWrites(env);
  if (!await ownsMailRouting(env, kind, value)) throw ownershipConflict();
}

export async function requireExistingMailboxOwnership(env: CloudflareEnv, ownerUserId: string, addressId: string) {
  if (!env.PRE_INBOUND_SETTINGS?.recipient && !readInboundRouting(env)) return;
  const address = await getManagedMailAddress(env.DB, ownerUserId, addressId);
  if (!address) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);
  await requireMailRoutingOwnership(env, 'mailbox', address.email);
}

export async function reserveMailRoutingOwnership(env: CloudflareEnv, kind: InboundRoutingKind, value: string) {
  requireMailRoutingWrites(env);
  if (conflictsWithFixedPreviewReservation(env, kind, value)) throw ownershipConflict();
  const routing = readInboundRouting(env);
  if (!routing) return;
  const limit = routing.environment === 'preview' && kind === 'catch_all'
    ? env.INBOUND_ROUTING_SCOPE?.previewCatchAllCapacity ?? (env.APP_ENV === 'preview' ? 0 : undefined)
    : undefined;
  if (!await claimInboundRoutingOwner(routing.db, kind, value, routing.environment, limit)) {
    if (limit !== undefined) {
      const owner = await findInboundRoutingOwner(routing.db, kind, value);
      if (!owner || owner === routing.environment) {
        throw new ApiError(409, 'MAIL_PREVIEW_CATCH_ALL_CAPACITY_REACHED', '生产定时检查容量已满，暂不能为 PRE 启用更多兜底域名。', undefined, undefined, false);
      }
    }
    throw ownershipConflict();
  }
}
