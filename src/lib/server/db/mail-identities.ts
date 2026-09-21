import type { MailboxIdentityFilter } from '$lib/domain/mail';
import {
  isMailHealthFresh,
  MAIL_HEALTH_MAX_AGE_MS,
  MAIL_HEALTH_TRANSIENT_COLLECT_GRACE_MS,
  TRANSIENT_CLOUDFLARE_HEALTH_ERRORS
} from '$lib/domain/mail/health';

export type InboundRecipientResolution =
  | {
      accepted: true;
      recipient: string;
      ownerUserId: string;
      mailDomainId: string;
      mailAddressId: string | null;
      recipientStatus: 'managed' | 'unregistered';
    }
  | {
      accepted: false;
      reason: 'invalid_recipient' | 'unknown_domain' | 'domain_disabled' | 'address_unavailable' | 'address_domain_mismatch';
    };

interface InboundRecipientRow {
  domain_id: string;
  owner_user_id: string;
  mapped_owner_id: string | null;
  domain_enabled: number;
  unknown_recipient_policy: 'reject' | 'collect';
  catch_all_target: 'unknown' | 'this_worker' | 'external' | 'drop' | 'none';
  catch_all_checked_at: string | null;
  cloudflare_error_code: string | null;
  cloudflare_error_at: string | null;
  address_id: string | null;
  address_domain_id: string | null;
  address_owner_user_id: string | null;
  lifecycle_status: 'active' | 'disabled' | 'deleted' | null;
  receive_enabled: number | null;
  routing_state: 'pending' | 'provisioning' | 'active' | 'deleting' | 'imported' | 'unknown' | 'error' | 'deleted' | null;
}

export async function resolveInboundRecipient(db: Pick<D1Database, 'prepare'>, rawRecipient: string, now = Date.now()): Promise<InboundRecipientResolution> {
  const recipient = rawRecipient.trim().toLowerCase();
  const separator = recipient.lastIndexOf('@');
  if (
    separator <= 0 ||
    separator === recipient.length - 1 ||
    recipient.indexOf('@') !== separator ||
    /\s/u.test(recipient)
  ) return { accepted: false, reason: 'invalid_recipient' };

  const domainName = recipient.slice(separator + 1);
  const row = await db.prepare(`
    SELECT
      d.id AS domain_id,
      d.owner_user_id,
      o.user_id AS mapped_owner_id,
      d.enabled AS domain_enabled,
      d.unknown_recipient_policy,
      d.catch_all_target,
      d.catch_all_checked_at,
      d.cloudflare_error_code,
      d.cloudflare_error_at,
      a.id AS address_id,
      a.domain_id AS address_domain_id,
      a.owner_user_id AS address_owner_user_id,
      a.lifecycle_status,
      a.receive_enabled,
      a.routing_state
    FROM mail_domains AS d
    LEFT JOIN workspace_owner AS o ON o.singleton = 1
    LEFT JOIN mail_addresses AS a ON lower(a.email) = ?
    WHERE lower(d.domain_name) = ?
    LIMIT 1
  `).bind(recipient, domainName).first<InboundRecipientRow>();

  if (!row) return { accepted: false, reason: 'unknown_domain' };
  if (!row.mapped_owner_id || row.mapped_owner_id !== row.owner_user_id) {
    throw new Error('INBOUND_OWNER_MAPPING_UNAVAILABLE');
  }
  if (!row.domain_enabled) return { accepted: false, reason: 'domain_disabled' };

  if (row.address_id) {
    if (row.address_domain_id !== row.domain_id || row.address_owner_user_id !== row.owner_user_id) {
      return { accepted: false, reason: 'address_domain_mismatch' };
    }
    if (
      row.lifecycle_status !== 'active' ||
      row.receive_enabled !== 1 ||
      !['active', 'imported'].includes(row.routing_state ?? '')
    ) return { accepted: false, reason: 'address_unavailable' };

    return {
      accepted: true,
      recipient,
      ownerUserId: row.owner_user_id,
      mailDomainId: row.domain_id,
      mailAddressId: row.address_id,
      recipientStatus: 'managed'
    };
  }

  const checkedAt = row.catch_all_checked_at ? Date.parse(row.catch_all_checked_at) : Number.NaN;
  const errorAt = row.cloudflare_error_at ? Date.parse(row.cloudflare_error_at) : Number.NaN;
  const catchAllWasRecentlyVerified = isMailHealthFresh(row.catch_all_checked_at, now);
  const transientFailureGrace = Number.isFinite(checkedAt) && checkedAt <= now &&
    now - checkedAt <= MAIL_HEALTH_MAX_AGE_MS + MAIL_HEALTH_TRANSIENT_COLLECT_GRACE_MS &&
    Number.isFinite(errorAt) && errorAt >= checkedAt && errorAt <= now &&
    TRANSIENT_CLOUDFLARE_HEALTH_ERRORS.has(row.cloudflare_error_code ?? '');
  if (
    row.unknown_recipient_policy === 'collect' && row.catch_all_target === 'this_worker' &&
    (catchAllWasRecentlyVerified || transientFailureGrace)
  ) {
    return {
      accepted: true,
      recipient,
      ownerUserId: row.owner_user_id,
      mailDomainId: row.domain_id,
      mailAddressId: null,
      recipientStatus: 'unregistered'
    };
  }
  return { accepted: false, reason: 'address_unavailable' };
}

export interface ManagedMailDomainRow {
  id: string;
  owner_user_id: string;
  domain_name: string;
  cloudflare_zone_id: string;
  cloudflare_account_id: string | null;
  worker_name: string;
  enabled: number;
  unknown_recipient_policy: 'reject' | 'collect';
  catch_all_target: 'unknown' | 'this_worker' | 'external' | 'drop' | 'none';
  catch_all_checked_at: string | null;
  resend_domain_id: string | null;
  resend_status: 'unknown' | 'pending' | 'verified' | 'failed';
  resend_sending_status: 'unknown' | 'enabled' | 'disabled';
  resend_checked_at: string | null;
  cloudflare_checked_at: string | null;
  cloudflare_next_check_at: string | null;
  cloudflare_check_token: string | null;
  cloudflare_check_expires_at: string | null;
  cloudflare_error_code: string | null;
  cloudflare_error_at: string | null;
  cloudflare_failure_count: number;
  resend_next_check_at: string | null;
  resend_check_token: string | null;
  resend_check_expires_at: string | null;
  resend_error_code: string | null;
  resend_error_at: string | null;
  resend_failure_count: number;
  last_error_code: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ManagedMailAddressRow {
  id: string;
  owner_user_id: string;
  domain_id: string;
  email: string;
  local_part: string;
  display_name: string;
  signature: string;
  receive_enabled: number;
  send_enabled: number;
  lifecycle_status: 'active' | 'disabled' | 'deleted';
  routing_state: 'pending' | 'provisioning' | 'active' | 'deleting' | 'imported' | 'unknown' | 'error' | 'deleted';
  routing_rule_id: string | null;
  routing_rule_source: 'api' | 'wrangler' | null;
  routing_owner: 'flaremail' | 'imported' | null;
  is_default_sender: number;
  operation_token: string | null;
  operation_expires_at: string | null;
  delete_route_policy: 'remove_owned_route' | 'retain_reject_route' | 'preserve_imported_route' | null;
  last_error_code: string | null;
  last_error_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function listManagedMailDomains(db: Pick<D1Database, 'prepare'>, ownerUserId: string) {
  const result = await db.prepare(`
    SELECT * FROM mail_domains
    WHERE owner_user_id = ?
    ORDER BY domain_name COLLATE NOCASE, id
  `).bind(ownerUserId).all<ManagedMailDomainRow>();
  return result.results ?? [];
}

export async function listManagedMailAddresses(db: Pick<D1Database, 'prepare'>, ownerUserId: string) {
  const result = await db.prepare(`
    SELECT * FROM mail_addresses
    WHERE owner_user_id = ?
    ORDER BY domain_id, email COLLATE NOCASE, id
  `).bind(ownerUserId).all<ManagedMailAddressRow>();
  return result.results ?? [];
}

export async function getManagedMailDomain(db: Pick<D1Database, 'prepare'>, ownerUserId: string, domainId: string) {
  return db.prepare(`
    SELECT * FROM mail_domains
    WHERE id = ? AND owner_user_id = ?
  `).bind(domainId, ownerUserId).first<ManagedMailDomainRow>();
}

export async function getManagedMailAddress(db: Pick<D1Database, 'prepare'>, ownerUserId: string, addressId: string) {
  return db.prepare(`
    SELECT * FROM mail_addresses
    WHERE id = ? AND owner_user_id = ?
  `).bind(addressId, ownerUserId).first<ManagedMailAddressRow>();
}

export async function mailboxIdentityFilterExists(
  db: Pick<D1Database, 'prepare'>,
  ownerUserId: string,
  filter: MailboxIdentityFilter
) {
  const table = filter.kind === 'domain' ? 'mail_domains' : 'mail_addresses';
  return Boolean(await db.prepare(`SELECT 1 AS found FROM ${table} WHERE id = ? AND owner_user_id = ? LIMIT 1`)
    .bind(filter.id, ownerUserId).first<{ found: number }>());
}

export async function listMailboxIdentityOptions(db: Pick<D1Database, 'prepare'>, ownerUserId: string) {
  const [domains, addresses] = await Promise.all([
    db.prepare(`SELECT id, domain_name FROM mail_domains WHERE owner_user_id = ? ORDER BY domain_name COLLATE NOCASE, id`)
      .bind(ownerUserId).all<{ id: string; domain_name: string }>(),
    db.prepare(`
      SELECT a.id, a.domain_id, a.email, a.display_name, a.lifecycle_status, a.send_enabled, a.is_default_sender,
        d.enabled AS domain_enabled, d.resend_status, d.resend_sending_status, d.resend_checked_at
      FROM mail_addresses AS a
      JOIN mail_domains AS d ON d.id = a.domain_id AND d.owner_user_id = a.owner_user_id
      WHERE a.owner_user_id = ? ORDER BY a.email COLLATE NOCASE, a.id
    `).bind(ownerUserId).all<{
      id: string; domain_id: string; email: string; display_name: string;
      lifecycle_status: ManagedMailAddressRow['lifecycle_status']; send_enabled: number; is_default_sender: number;
      domain_enabled: number; resend_status: ManagedMailDomainRow['resend_status'];
      resend_sending_status: ManagedMailDomainRow['resend_sending_status']; resend_checked_at: string | null;
    }>()
  ]);
  const now = Date.now();
  return {
    domains: (domains.results ?? []).map(({ id, domain_name }) => ({ id, domainName: domain_name })),
    addresses: (addresses.results ?? []).map((row) => {
      const recentCheck = isMailHealthFresh(row.resend_checked_at, now);
      return {
        id: row.id,
        domainId: row.domain_id,
        email: row.email,
        displayName: row.display_name,
        lifecycleStatus: row.lifecycle_status,
        sendEnabled: row.send_enabled === 1,
        isDefaultSender: row.is_default_sender === 1,
        sendReady: row.lifecycle_status === 'active' && row.send_enabled === 1 && row.domain_enabled === 1 &&
          row.resend_status === 'verified' && row.resend_sending_status === 'enabled' && recentCheck
      };
    })
  };
}
