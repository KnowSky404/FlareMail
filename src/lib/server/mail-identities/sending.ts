import type { CloudflareEnv } from '$lib/server/cloudflare';
import {
  getManagedMailAddress,
  getManagedMailDomain,
  type ManagedMailAddressRow,
  type ManagedMailDomainRow
} from '$lib/server/db/mail-identities';
import { isValidEmail } from '$lib/domain/mail';
import { ApiError } from '$lib/server/http/api';

const maxResendCheckAgeMs = 24 * 60 * 60 * 1000;

export type MailAddressSendingAction = 'enable_send' | 'disable_send' | 'make_default';

function assertDomainSendReady(domain: ManagedMailDomainRow | null): asserts domain is ManagedMailDomainRow {
  if (!domain || !domain.enabled) {
    throw new ApiError(409, 'MAIL_DOMAIN_DISABLED', '此邮件域名已停用，不能启用发信。', undefined, undefined, false);
  }
  const checkedAt = domain.resend_checked_at ? Date.parse(domain.resend_checked_at) : Number.NaN;
  if (
    domain.resend_status !== 'verified' ||
    domain.resend_sending_status !== 'enabled' ||
    !Number.isFinite(checkedAt) ||
    checkedAt > Date.now() ||
    Date.now() - checkedAt > maxResendCheckAgeMs
  ) {
    throw new ApiError(
      409,
      'MAIL_DOMAIN_SENDING_NOT_READY',
      '请先检查域名，并确认 Resend 发信状态为已验证且已启用。',
      undefined,
      { reason: 'resend_domain_not_ready' },
      false
    );
  }
}

/** Resolve a client choice to an owned, explicitly enabled From identity. */
export async function resolveManagedMailSender(
  db: Pick<D1Database, 'prepare'>,
  ownerUserId: string,
  requestedAddressId: string | null | undefined
): Promise<{ address: ManagedMailAddressRow; domain: ManagedMailDomainRow }> {
  const address = requestedAddressId === undefined
    ? await db.prepare(`
        SELECT * FROM mail_addresses
        WHERE owner_user_id = ? AND is_default_sender = 1
        LIMIT 1
      `).bind(ownerUserId).first<ManagedMailAddressRow>()
    : requestedAddressId === null
      ? null
      : await getManagedMailAddress(db, ownerUserId, requestedAddressId);

  if (!address) {
    throw new ApiError(409, 'OUTBOUND_SENDER_NOT_SELECTED', '请先选择一个已启用的发件地址。', undefined, undefined, false);
  }
  if (address.lifecycle_status !== 'active' || address.send_enabled !== 1) {
    throw new ApiError(409, 'OUTBOUND_SENDER_DISABLED', '所选发件地址已停用。请在设置中恢复发信，或选择其他地址。', undefined, undefined, false);
  }
  const domain = await getManagedMailDomain(db, ownerUserId, address.domain_id);
  assertDomainSendReady(domain);
  const expectedEmail = `${address.local_part}@${domain.domain_name}`.toLowerCase();
  if (!isValidEmail(address.email) || address.email.trim().toLowerCase() !== expectedEmail) {
    throw new ApiError(409, 'MAIL_SENDER_CONFIGURATION_INVALID', '发件地址配置与受管域名不一致，未发送邮件。', undefined, undefined, false);
  }
  return { address, domain };
}

export async function updateManagedMailAddressSending(
  env: CloudflareEnv,
  ownerUserId: string,
  addressId: string,
  action: MailAddressSendingAction
) {
  if (!env.DB) throw new ApiError(503, 'D1_UNAVAILABLE', '工作区数据服务暂时不可用。');
  const address = await getManagedMailAddress(env.DB, ownerUserId, addressId);
  if (!address) throw new ApiError(404, 'MAIL_ADDRESS_NOT_FOUND', '邮件地址不存在。', undefined, undefined, false);

  if (action === 'disable_send') {
    await env.DB.prepare(
      'UPDATE mail_addresses SET send_enabled = 0, is_default_sender = 0, updated_at = ? ' +
      'WHERE id = ? AND owner_user_id = ?'
    ).bind(new Date().toISOString(), addressId, ownerUserId).run();
    return getManagedMailAddress(env.DB, ownerUserId, addressId);
  }

  if (address.lifecycle_status !== 'active') {
    throw new ApiError(409, 'MAIL_ADDRESS_NOT_ACTIVE', '已停用或删除的邮件地址不能启用发信。', undefined, undefined, false);
  }
  const domain = await getManagedMailDomain(env.DB, ownerUserId, address.domain_id);
  assertDomainSendReady(domain);
  const now = new Date().toISOString();

  if (action === 'enable_send') {
    await env.DB.prepare(
      'UPDATE mail_addresses SET send_enabled = 1, updated_at = ? WHERE id = ? AND owner_user_id = ? AND lifecycle_status = \'active\''
    ).bind(now, addressId, ownerUserId).run();
  } else {
    if (address.send_enabled !== 1) {
      throw new ApiError(409, 'MAIL_ADDRESS_SENDING_DISABLED', '请先启用此邮件地址的发信。', undefined, undefined, false);
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE mail_addresses SET is_default_sender = 0, updated_at = ? WHERE owner_user_id = ? AND is_default_sender = 1')
        .bind(now, ownerUserId),
      env.DB.prepare(
        'UPDATE mail_addresses SET is_default_sender = 1, updated_at = ? WHERE id = ? AND owner_user_id = ? AND send_enabled = 1 AND lifecycle_status = \'active\''
      ).bind(now, addressId, ownerUserId)
    ]);
  }
  return getManagedMailAddress(env.DB, ownerUserId, addressId);
}
