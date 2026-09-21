export interface MailIdentityAuditArguments {
  domains: string[];
  json: boolean;
  persistTo?: string;
}

export type MailIdentityAuditRow = Record<string, unknown> & { report_section: string };

function normalizeDomain(value: string) {
  const input = value.trim().toLowerCase().replace(/\.$/u, '');
  if (!input || /[\\/@?#:\s]/u.test(input)) throw new Error('Invalid --domain value.');
  let hostname: string;
  try {
    hostname = new URL('https://' + input).hostname.toLowerCase();
  } catch {
    throw new Error('Invalid --domain value.');
  }
  if (!hostname.includes('.') || hostname.length > 253 || hostname.includes(':') || /^\d+(?:\.\d+){3}$/u.test(hostname)) {
    throw new Error('Invalid --domain value.');
  }
  return hostname;
}

export function parseMailIdentityAuditArguments(args: string[]): MailIdentityAuditArguments {
  const domains = new Set<string>();
  let json = false;
  let persistTo: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--remote' || argument.startsWith('--remote=')) {
      throw new Error('This migration audit is local-only; --remote is not supported.');
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--persist-to' || argument.startsWith('--persist-to=')) {
      if (persistTo) throw new Error('--persist-to may be specified only once.');
      const value = argument === '--persist-to' ? args[index + 1] : argument.slice('--persist-to='.length);
      if (!value || value.startsWith('--')) throw new Error('--persist-to requires a local persistence directory.');
      persistTo = value;
      if (argument === '--persist-to') index += 1;
      continue;
    }
    if (argument === '--domain') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--domain requires a DNS domain name.');
      domains.add(normalizeDomain(value));
      index += 1;
      continue;
    }
    if (argument.startsWith('--domain=')) {
      domains.add(normalizeDomain(argument.slice('--domain='.length)));
      continue;
    }
    throw new Error('Unsupported migration audit argument: ' + argument);
  }
  return { domains: [...domains].sort(), json, ...(persistTo ? { persistTo } : {}) };
}

function valueString(value: unknown) {
  return typeof value === 'string' && value ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function addressDomain(value: unknown) {
  const email = valueString(value)?.trim().toLowerCase();
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1 || email.indexOf('@') !== at) return null;
  return { email, domain: email.slice(at + 1) };
}

export function buildMailIdentityDryRunReport(
  rows: MailIdentityAuditRow[],
  explicitDomainNames: string[],
  generatedAt = new Date().toISOString()
) {
  const sections = new Map<string, MailIdentityAuditRow[]>();
  for (const row of rows) {
    const current = sections.get(row.report_section) ?? [];
    current.push(row);
    sections.set(row.report_section, current);
  }
  const users = sections.get('user') ?? [];
  const ownerRows = sections.get('owner_mapping') ?? [];
  const configuredDomains = [...new Set([
    ...explicitDomainNames,
    ...(sections.get('configured_domain') ?? []).map((row) => valueString(row.domain_name)).filter((value): value is string => Boolean(value))
  ])].map((value) => value.toLowerCase()).sort();
  const userIds = new Set(users.map((row) => valueString(row.user_id)));
  const stableOwnerId = valueString(ownerRows[0]?.owner_id);

  const inboundEnvelopeRecipients = (sections.get('inbound_recipient') ?? []).map((row) => {
    const address = addressDomain(row.email);
    return {
      ownerId: valueString(row.owner_id),
      email: valueString(row.email),
      count: numberValue(row.count),
      firstSeen: valueString(row.first_seen),
      lastSeen: valueString(row.last_seen),
      explicitDomainMatch: Boolean(address && configuredDomains.includes(address.domain)),
      ownerExists: Boolean(row.owner_id && userIds.has(valueString(row.owner_id)))
    };
  });

  const senderAddresses = (sections.get('outbound_sender') ?? []).map((row) => ({
    ownerId: valueString(row.owner_id),
    email: valueString(row.email),
    count: numberValue(row.count),
    explicitDomainMatch: Boolean(addressDomain(row.email) && configuredDomains.includes(addressDomain(row.email)!.domain)),
    ownerExists: Boolean(row.owner_id && userIds.has(valueString(row.owner_id)))
  }));
  const draftAddresses = (sections.get('draft_recipient') ?? []).map((row) => ({
    ownerId: valueString(row.owner_id),
    email: valueString(row.email),
    count: numberValue(row.count),
    explicitDomainMatch: Boolean(addressDomain(row.email) && configuredDomains.includes(addressDomain(row.email)!.domain)),
    ownerExists: Boolean(row.owner_id && userIds.has(valueString(row.owner_id)))
  }));

  const countUnowned = (section: string) => (sections.get(section) ?? [])
    .filter((row) => !valueString(row.owner_id))
    .reduce((total, row) => total + numberValue(row.count), 0);
  const ownerMismatches = rows.filter((row) => {
    const ownerId = valueString(row.owner_id);
    return ownerId && !userIds.has(ownerId);
  }).map((row) => ({ reportSection: row.report_section, ownerId: valueString(row.owner_id) }));

  return {
    generatedAt,
    mode: 'local-read-only',
    explicitDomains: configuredDomains,
    owner: {
      historicalUserCount: users.length,
      users: users.map((row) => ({
        userId: valueString(row.user_id),
        loginIdentifier: valueString(row.login_email),
        profileEmail: valueString(row.profile_email)
      })),
      stableOwnerId,
      ownerMappingPresent: Boolean(stableOwnerId),
      multipleHistoricalUsers: users.length > 1,
      authUsernames: (sections.get('auth_username') ?? []).map((row) => ({
        ownerId: valueString(row.owner_id),
        username: valueString(row.username)
      }))
    },
    inbound: {
      count: numberValue((sections.get('inbound_total') ?? [])[0]?.count),
      unownedCount: countUnowned('inbound_owner_count'),
      envelopeRecipients: inboundEnvelopeRecipients,
      legacyUnmappedCount: numberValue((sections.get('legacy_unmapped') ?? [])[0]?.count)
    },
    outbound: {
      count: numberValue((sections.get('outbound_total') ?? [])[0]?.count),
      unownedCount: countUnowned('outbound_owner_count'),
      fromAddresses: senderAddresses
    },
    drafts: {
      count: numberValue((sections.get('draft_total') ?? [])[0]?.count),
      unownedCount: countUnowned('draft_owner_count'),
      recipients: draftAddresses,
      senderSnapshotAvailable: (sections.get('draft_sender_schema') ?? []).length > 0,
      fromAddresses: (sections.get('draft_sender') ?? []).map((row) => ({
        ownerId: valueString(row.owner_id),
        email: valueString(row.email),
        count: numberValue(row.count)
      }))
    },
    storage: {
      attachments: sections.get('attachment_ownership') ?? [],
      bodyObjects: sections.get('body_ownership') ?? [],
      bodyObjectsWithoutOwnerCount: countUnowned('body_ownership'),
      orphanAttachments: numberValue((sections.get('orphan_attachments') ?? [])[0]?.count),
      orphanBodyObjects: numberValue((sections.get('orphan_body_objects') ?? [])[0]?.count)
    },
    notifications: {
      telegramBindings: sections.get('telegram_binding_ownership') ?? [],
      telegramDeliveries: sections.get('telegram_delivery_ownership') ?? []
    },
    conflicts: {
      missingHistoricalOwnerCount: users.filter((row) => !userIds.has(valueString(row.user_id))).length,
      ownerMappingsToUnknownUsers: ownerRows.filter((row) => !userIds.has(valueString(row.owner_id))).map((row) => valueString(row.owner_id)),
      rowsPointingToUnknownOwners: ownerMismatches
    },
    safety: {
      historicalRecipientsAreNotAutomaticallyMapped: true,
      profileAndLoginEmailsAreNotTreatedAsSenders: true,
      noWritesPerformed: true
    }
  };
}
