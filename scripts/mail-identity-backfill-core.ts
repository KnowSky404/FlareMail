import { createHash } from 'node:crypto';
import { FLAREMAIL_SCHEMA_VERSION } from '../src/lib/server/db/schema-version';

export const MAIL_IDENTITY_BACKFILL_PLAN_VERSION = 1 as const;
export const MAIL_IDENTITY_BACKFILL_SCHEMA_VERSION = FLAREMAIL_SCHEMA_VERSION;
export const MAIL_IDENTITY_BACKFILL_MAX_BATCH = 100;
export const MAIL_IDENTITY_BACKFILL_TTL_MS = 24 * 60 * 60 * 1000;

export type LegacyRecipientStatus = 'legacy-unmapped' | 'unregistered';

export interface MailIdentityBackfillTarget {
  ownerUserId: string;
  addressId: string;
  addressEmail: string;
  domainId: string;
  domainName: string;
}

export interface MailIdentityBackfillExecutionTarget {
  mode: 'local';
  database: 'flaremail-db';
  config: 'wrangler.toml';
  persistTo: string;
}

export interface MailIdentityBackfillRecord {
  messageId: string;
  ownerUserId: string;
  envelopeTo: string;
  direction: 'inbound';
  timestamp: string;
  createdAt: string;
  mailDomainId: string | null;
  mailAddressId: null;
  recipientStatus: LegacyRecipientStatus;
}

export interface MailIdentityBackfillObservedRecord extends Omit<MailIdentityBackfillRecord, 'mailAddressId' | 'recipientStatus'> {
  mailAddressId: string | null;
  recipientStatus: 'legacy-unmapped' | 'unregistered' | 'managed';
  searchProjectionOwnerUserId: string | null;
  searchProjectionAddressId: string | null;
}

export interface MailIdentityBackfillConflictCounts {
  unowned: number;
  otherOwner: number;
  mappedToOtherAddress: number;
  domainMismatch: number;
  stateMismatch: number;
  alreadyMapped: number;
}

interface MailIdentityBackfillPlanContent {
  planVersion: typeof MAIL_IDENTITY_BACKFILL_PLAN_VERSION;
  schemaVersion: typeof MAIL_IDENTITY_BACKFILL_SCHEMA_VERSION;
  generatedAt: string;
  expiresAt: string;
  executionTarget: MailIdentityBackfillExecutionTarget;
  target: MailIdentityBackfillTarget;
  selection: {
    sourceField: 'email_messages."to"';
    ownerMustAlreadyMatch: true;
    statuses: LegacyRecipientStatus[];
    afterId: string | null;
    limit: number;
    plannedCount: number;
    hasMore: boolean;
    nextAfterId: string | null;
  };
  records: MailIdentityBackfillRecord[];
  conflicts: MailIdentityBackfillConflictCounts;
  excluded: {
    outboundUnmappedCount: number;
    draftsWithoutSenderCount: number;
    outboundPolicy: 'manual_review_actual_from_not_proven_by_legacy_snapshot';
    draftsPolicy: 'preserve_content_and_require_explicit_sender_choice';
  };
  effects: {
    changesOwner: false;
    changesOutboundMessages: false;
    changesDrafts: false;
    writesR2: false;
    sendsMailOrNotifications: false;
    updatesInboundSearchProjection: true;
  };
}

export interface MailIdentityBackfillPlan extends MailIdentityBackfillPlanContent {
  digest: string;
}

export interface MailIdentityBackfillStore {
  readonly executionTarget: MailIdentityBackfillExecutionTarget;
  getSchemaVersion(): Promise<number | null>;
  getTarget(ownerUserId: string, addressId: string): Promise<MailIdentityBackfillTarget | null>;
  findCandidates(target: MailIdentityBackfillTarget, afterId: string | null, limit: number): Promise<MailIdentityBackfillRecord[]>;
  getConflictCounts(target: MailIdentityBackfillTarget): Promise<MailIdentityBackfillConflictCounts>;
  countUnmappedOutbound(ownerUserId: string): Promise<number>;
  countDraftsWithoutSender(ownerUserId: string): Promise<number>;
  inspect(records: MailIdentityBackfillRecord[]): Promise<MailIdentityBackfillObservedRecord[]>;
  applyUpdate(target: MailIdentityBackfillTarget, records: MailIdentityBackfillRecord[]): Promise<void>;
}

export interface BackfillCliOptions {
  command: 'plan' | 'apply' | 'verify';
  persistTo: string;
  ownerUserId?: string;
  addressId?: string;
  outputPath?: string;
  planPath?: string;
  confirm?: string;
  applyConfirmed: boolean;
  limit: number;
  afterId?: string;
}

export type BackfillRecordState = 'pending' | 'applied' | 'missing' | 'conflict' | 'projection_mismatch';

export interface BackfillRecordResult {
  messageId: string;
  state: BackfillRecordState;
}

export interface MailIdentityBackfillResult {
  command: 'apply' | 'verify';
  status: 'complete' | 'blocked' | 'partial' | 'incomplete';
  planDigest: string;
  target: MailIdentityBackfillTarget;
  plannedCount: number;
  appliedBefore: number;
  pendingBefore: number;
  appliedAfter: number;
  pendingAfter: number;
  conflictCount: number;
  missingCount: number;
  projectionMismatchCount: number;
  mutationAttempted: boolean;
  mutationErrorCode: 'local_apply_failed' | null;
  records: BackfillRecordResult[];
};

function positiveInteger(value: string, flag: string) {
  if (!/^\d+$/u.test(value)) throw new Error(`${flag} requires a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} requires a positive integer.`);
  return parsed;
}

function requiredString(value: string | undefined, flag: string) {
  if (!value?.trim() || value.length > 4096) throw new Error(`${flag} requires a value.`);
  return value.trim();
}

export function parseMailIdentityBackfillArguments(args: string[]): BackfillCliOptions {
  const normalized = args[0] === '--' ? args.slice(1) : args;
  const command = normalized[0];
  if (command !== 'plan' && command !== 'apply' && command !== 'verify') {
    throw new Error('Specify plan, apply, or verify. This command is local-only.');
  }

  const values = new Map<string, string>();
  let applyConfirmed = false;
  for (let index = 1; index < normalized.length; index += 1) {
    const argument = normalized[index]!;
    if (argument === '--remote' || argument.startsWith('--remote=')) {
      throw new Error('This history backfill is local-only; --remote is not supported.');
    }
    if (argument === '--apply') {
      if (applyConfirmed) throw new Error('--apply may be specified only once.');
      applyConfirmed = true;
      continue;
    }
    const match = /^(--[a-z-]+)(?:=(.*))?$/u.exec(argument);
    if (!match) throw new Error(`Unsupported argument: ${argument}`);
    const flag = match[1]!;
    const allowed = new Set(['--persist-to', '--owner-id', '--address-id', '--out', '--plan', '--confirm', '--limit', '--after-id']);
    if (!allowed.has(flag)) throw new Error(`Unsupported argument: ${flag}`);
    if (values.has(flag)) throw new Error(`${flag} may be specified only once.`);
    const value = match[2] ?? normalized[++index];
    values.set(flag, requiredString(value, flag));
  }

  const persistTo = requiredString(values.get('--persist-to'), '--persist-to');
  const limit = values.has('--limit') ? positiveInteger(values.get('--limit')!, '--limit') : MAIL_IDENTITY_BACKFILL_MAX_BATCH;
  if (limit > MAIL_IDENTITY_BACKFILL_MAX_BATCH) throw new Error(`--limit cannot exceed ${MAIL_IDENTITY_BACKFILL_MAX_BATCH}.`);
  const afterId = values.get('--after-id');
  const ownerUserId = values.get('--owner-id');
  const addressId = values.get('--address-id');
  const outputPath = values.get('--out');
  const planPath = values.get('--plan');
  const confirm = values.get('--confirm')?.toLowerCase();

  if (confirm && !/^[a-f0-9]{64}$/u.test(confirm)) throw new Error('--confirm requires the plan SHA-256 digest.');
  if (command === 'plan') {
    if (!ownerUserId || !addressId || !outputPath) throw new Error('plan requires --owner-id, --address-id, and --out.');
    if (planPath || confirm || applyConfirmed) throw new Error('plan does not accept --plan, --confirm, or --apply.');
    if (afterId && afterId.length > 256) throw new Error('--after-id is too long.');
  } else if (command === 'apply') {
    if (!planPath || !confirm || !applyConfirmed) throw new Error('apply requires --plan, --confirm, and explicit --apply.');
    if (ownerUserId || addressId || outputPath || afterId || values.has('--limit')) {
      throw new Error('apply accepts only --persist-to, --plan, --confirm, and --apply.');
    }
  } else {
    if (!planPath) throw new Error('verify requires --plan.');
    if (ownerUserId || addressId || outputPath || afterId || confirm || applyConfirmed || values.has('--limit')) {
      throw new Error('verify accepts only --persist-to and --plan.');
    }
  }

  return {
    command,
    persistTo,
    ...(ownerUserId ? { ownerUserId } : {}),
    ...(addressId ? { addressId } : {}),
    ...(outputPath ? { outputPath } : {}),
    ...(planPath ? { planPath } : {}),
    ...(confirm ? { confirm } : {}),
    applyConfirmed,
    limit,
    ...(afterId ? { afterId } : {})
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function digestContent(content: MailIdentityBackfillPlanContent) {
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

export function verifyMailIdentityBackfillPlanDigest(plan: MailIdentityBackfillPlan) {
  const { digest, ...content } = plan;
  return /^[a-f0-9]{64}$/u.test(digest) && digestContent(content) === digest;
}

function normalizedEmail(value: string) {
  const email = value.trim().toLowerCase();
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1 || /[\s<>(),;:\\]/u.test(email)) {
    throw new Error('The selected mail address is not a single normalized email address.');
  }
  return email;
}

export async function createMailIdentityBackfillPlan(
  store: MailIdentityBackfillStore,
  input: { ownerUserId: string; addressId: string; afterId?: string; limit?: number; now?: Date }
): Promise<MailIdentityBackfillPlan> {
  const schemaVersion = await store.getSchemaVersion();
  if (schemaVersion !== MAIL_IDENTITY_BACKFILL_SCHEMA_VERSION) {
    throw new Error(`History backfill requires local schema version ${MAIL_IDENTITY_BACKFILL_SCHEMA_VERSION}; found ${schemaVersion ?? 'missing'}.`);
  }
  const target = await store.getTarget(input.ownerUserId, input.addressId);
  if (!target || target.ownerUserId !== input.ownerUserId || target.addressId !== input.addressId) {
    throw new Error('The explicit Owner, address, and stable Owner mapping must all match.');
  }
  const addressEmail = normalizedEmail(target.addressEmail);
  if (addressEmail !== target.addressEmail) throw new Error('The selected mail address must use its normalized stored email.');
  const limit = input.limit ?? MAIL_IDENTITY_BACKFILL_MAX_BATCH;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAIL_IDENTITY_BACKFILL_MAX_BATCH) {
    throw new Error(`Backfill limit must be between 1 and ${MAIL_IDENTITY_BACKFILL_MAX_BATCH}.`);
  }

  const candidates = await store.findCandidates(target, input.afterId ?? null, limit + 1);
  const hasMore = candidates.length > limit;
  const records = candidates.slice(0, limit);
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const content: MailIdentityBackfillPlanContent = {
    planVersion: MAIL_IDENTITY_BACKFILL_PLAN_VERSION,
    schemaVersion: MAIL_IDENTITY_BACKFILL_SCHEMA_VERSION,
    generatedAt,
    expiresAt: new Date(now.getTime() + MAIL_IDENTITY_BACKFILL_TTL_MS).toISOString(),
    executionTarget: store.executionTarget,
    target: { ...target, addressEmail },
    selection: {
      sourceField: 'email_messages."to"',
      ownerMustAlreadyMatch: true,
      statuses: ['legacy-unmapped', 'unregistered'],
      afterId: input.afterId ?? null,
      limit,
      plannedCount: records.length,
      hasMore,
      nextAfterId: hasMore ? records.at(-1)?.messageId ?? input.afterId ?? null : null
    },
    records,
    conflicts: await store.getConflictCounts(target),
    excluded: {
      outboundUnmappedCount: await store.countUnmappedOutbound(target.ownerUserId),
      draftsWithoutSenderCount: await store.countDraftsWithoutSender(target.ownerUserId),
      outboundPolicy: 'manual_review_actual_from_not_proven_by_legacy_snapshot',
      draftsPolicy: 'preserve_content_and_require_explicit_sender_choice'
    },
    effects: {
      changesOwner: false,
      changesOutboundMessages: false,
      changesDrafts: false,
      writesR2: false,
      sendsMailOrNotifications: false,
      updatesInboundSearchProjection: true
    }
  };
  return { ...content, digest: digestContent(content) };
}

export function validateMailIdentityBackfillPlan(value: unknown): MailIdentityBackfillPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plan file must contain a JSON object.');
  const plan = value as MailIdentityBackfillPlan;
  if (plan.planVersion !== MAIL_IDENTITY_BACKFILL_PLAN_VERSION || plan.schemaVersion !== MAIL_IDENTITY_BACKFILL_SCHEMA_VERSION) {
    throw new Error('Unsupported history backfill plan or schema version.');
  }
  if (!Array.isArray(plan.records) || plan.records.length > MAIL_IDENTITY_BACKFILL_MAX_BATCH || !plan.selection ||
      plan.selection.plannedCount !== plan.records.length || plan.selection.limit < plan.records.length ||
      plan.selection.limit > MAIL_IDENTITY_BACKFILL_MAX_BATCH || typeof plan.selection.hasMore !== 'boolean' ||
      (plan.selection.hasMore && !plan.selection.nextAfterId) || (!plan.selection.hasMore && plan.selection.nextAfterId !== null) ||
      new Set(plan.records.map((record) => record?.messageId)).size !== plan.records.length) {
    throw new Error('Plan record count or batch limit is invalid.');
  }
  if (!plan.executionTarget || plan.executionTarget.mode !== 'local' || plan.executionTarget.database !== 'flaremail-db' ||
      plan.executionTarget.config !== 'wrangler.toml' || !plan.executionTarget.persistTo ||
      !plan.target || !plan.target.ownerUserId || !plan.target.addressId || !plan.target.domainId ||
      normalizedEmail(plan.target.addressEmail) !== plan.target.addressEmail) {
    throw new Error('Plan target is incomplete or invalid.');
  }
  if (!Number.isFinite(Date.parse(plan.generatedAt)) || !Number.isFinite(Date.parse(plan.expiresAt))) {
    throw new Error('Plan timestamps are invalid.');
  }
  if (!plan.conflicts || !plan.excluded || plan.selection.sourceField !== 'email_messages."to"' || plan.selection.ownerMustAlreadyMatch !== true ||
      !plan.effects || plan.effects.changesOwner !== false || plan.effects.changesOutboundMessages !== false ||
      plan.effects.changesDrafts !== false || plan.effects.writesR2 !== false || plan.effects.sendsMailOrNotifications !== false ||
      plan.effects.updatesInboundSearchProjection !== true || !verifyMailIdentityBackfillPlanDigest(plan)) {
    throw new Error('Plan digest or safety declarations are invalid.');
  }
  for (const record of plan.records) {
    if (!record.messageId || !record.timestamp || !record.createdAt || record.ownerUserId !== plan.target.ownerUserId || record.direction !== 'inbound' ||
        record.mailAddressId !== null || !['legacy-unmapped', 'unregistered'].includes(record.recipientStatus) ||
        normalizedEmail(record.envelopeTo) !== plan.target.addressEmail ||
        (record.recipientStatus === 'unregistered' && record.mailDomainId !== plan.target.domainId) ||
        (record.recipientStatus === 'legacy-unmapped' && record.mailDomainId !== null && record.mailDomainId !== plan.target.domainId)) {
      throw new Error('Plan contains an ineligible inbound record.');
    }
  }
  return plan;
}

function sameStableSnapshot(expected: MailIdentityBackfillRecord, actual: MailIdentityBackfillObservedRecord) {
  return expected.messageId === actual.messageId && expected.ownerUserId === actual.ownerUserId &&
    expected.envelopeTo === actual.envelopeTo && expected.direction === actual.direction &&
    expected.timestamp === actual.timestamp && expected.createdAt === actual.createdAt;
}

function classifyRecord(
  target: MailIdentityBackfillTarget,
  expected: MailIdentityBackfillRecord,
  actual: MailIdentityBackfillObservedRecord | undefined
): BackfillRecordResult {
  if (!actual) return { messageId: expected.messageId, state: 'missing' };
  if (!sameStableSnapshot(expected, actual)) return { messageId: expected.messageId, state: 'conflict' };

  if (actual.mailAddressId === target.addressId && actual.mailDomainId === target.domainId && actual.recipientStatus === 'managed') {
    return actual.searchProjectionOwnerUserId === target.ownerUserId && actual.searchProjectionAddressId === target.addressId
      ? { messageId: expected.messageId, state: 'applied' }
      : { messageId: expected.messageId, state: 'projection_mismatch' };
  }

  const sameIdentitySnapshot = actual.mailAddressId === null && actual.mailDomainId === expected.mailDomainId &&
    actual.recipientStatus === expected.recipientStatus;
  return sameIdentitySnapshot
    ? { messageId: expected.messageId, state: 'pending' }
    : { messageId: expected.messageId, state: 'conflict' };
}

function summarizeResults(command: 'apply' | 'verify', plan: MailIdentityBackfillPlan, records: BackfillRecordResult[], before: BackfillRecordResult[], mutationAttempted: boolean, mutationErrorCode: 'local_apply_failed' | null): MailIdentityBackfillResult {
  const count = (state: BackfillRecordState) => records.filter((record) => record.state === state).length;
  const appliedBefore = before.filter((record) => record.state === 'applied').length;
  const pendingBefore = before.filter((record) => record.state === 'pending').length;
  const appliedAfter = count('applied');
  const pendingAfter = count('pending');
  const conflictCount = count('conflict');
  const missingCount = count('missing');
  const projectionMismatchCount = count('projection_mismatch');
  const blockedBeforeMutation = before.some((record) => ['conflict', 'missing', 'projection_mismatch'].includes(record.state));
  const status = command === 'verify'
    ? appliedAfter === plan.records.length ? 'complete' : conflictCount + missingCount + projectionMismatchCount > 0 ? 'blocked' : 'incomplete'
    : blockedBeforeMutation && !mutationAttempted ? 'blocked'
      : appliedAfter === plan.records.length && !mutationErrorCode ? 'complete'
        : 'partial';
  return {
    command,
    status,
    planDigest: plan.digest,
    target: plan.target,
    plannedCount: plan.records.length,
    appliedBefore,
    pendingBefore,
    appliedAfter,
    pendingAfter,
    conflictCount,
    missingCount,
    projectionMismatchCount,
    mutationAttempted,
    mutationErrorCode,
    records
  };
}

async function inspectPlanRecords(store: MailIdentityBackfillStore, plan: MailIdentityBackfillPlan) {
  const observed = await store.inspect(plan.records);
  const byId = new Map(observed.map((record) => [record.messageId, record]));
  return plan.records.map((record) => classifyRecord(plan.target, record, byId.get(record.messageId)));
}

export async function verifyMailIdentityBackfillPlan(
  store: MailIdentityBackfillStore,
  input: MailIdentityBackfillPlan
): Promise<MailIdentityBackfillResult> {
  const plan = validateMailIdentityBackfillPlan(input);
  if (canonicalJson(store.executionTarget) !== canonicalJson(plan.executionTarget)) {
    throw new Error('The local D1 persistence path or config changed after the plan was created.');
  }
  const schemaVersion = await store.getSchemaVersion();
  if (schemaVersion !== plan.schemaVersion) throw new Error('The local schema changed after the plan was created.');
  const currentTarget = await store.getTarget(plan.target.ownerUserId, plan.target.addressId);
  if (!currentTarget || canonicalJson(currentTarget) !== canonicalJson(plan.target)) {
    throw new Error('The explicit Owner/address/domain target changed after the plan was created.');
  }
  const states = await inspectPlanRecords(store, plan);
  return summarizeResults('verify', plan, states, states, false, null);
}

export async function applyMailIdentityBackfillPlan(
  store: MailIdentityBackfillStore,
  input: MailIdentityBackfillPlan,
  confirmation: string,
  now = new Date()
): Promise<MailIdentityBackfillResult> {
  const plan = validateMailIdentityBackfillPlan(input);
  if (canonicalJson(store.executionTarget) !== canonicalJson(plan.executionTarget)) {
    throw new Error('The local D1 persistence path or config changed after the plan was created.');
  }
  if (!confirmation || confirmation.toLowerCase() !== plan.digest) throw new Error('The explicit --confirm value must equal the plan digest.');
  if (Date.parse(plan.expiresAt) <= now.getTime()) throw new Error('The backfill plan has expired; create a fresh read-only plan.');
  const schemaVersion = await store.getSchemaVersion();
  if (schemaVersion !== plan.schemaVersion) throw new Error('The local schema changed after the plan was created.');
  const currentTarget = await store.getTarget(plan.target.ownerUserId, plan.target.addressId);
  if (!currentTarget || canonicalJson(currentTarget) !== canonicalJson(plan.target)) {
    throw new Error('The explicit Owner/address/domain target changed after the plan was created.');
  }

  const before = await inspectPlanRecords(store, plan);
  if (before.some((record) => ['conflict', 'missing', 'projection_mismatch'].includes(record.state))) {
    return summarizeResults('apply', plan, before, before, false, null);
  }

  const pendingIds = new Set(before.filter((record) => record.state === 'pending').map((record) => record.messageId));
  const pendingRecords = plan.records.filter((record) => pendingIds.has(record.messageId));
  let mutationErrorCode: 'local_apply_failed' | null = null;
  if (pendingRecords.length) {
    try {
      await store.applyUpdate(plan.target, pendingRecords);
    } catch {
      mutationErrorCode = 'local_apply_failed';
    }
  }
  const after = await inspectPlanRecords(store, plan);
  return summarizeResults('apply', plan, after, before, pendingRecords.length > 0, mutationErrorCode);
}

export function sqliteText(value: string) {
  return `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`;
}

export function buildMailIdentityBackfillSchemaVersionSql() {
  return "SELECT schema_version FROM workspace_schema_metadata WHERE schema_name = 'flaremail';";
}

export function buildMailIdentityBackfillTargetSql(ownerUserId: string, addressId: string) {
  return `SELECT o.user_id AS owner_user_id, u.id AS workspace_user_id,
    a.id AS address_id, a.owner_user_id AS address_owner_user_id, a.domain_id,
    a.email AS address_email, d.id AS joined_domain_id, d.domain_name,
    d.owner_user_id AS domain_owner_user_id
  FROM workspace_owner AS o
  JOIN workspace_users AS u ON u.id = o.user_id
  JOIN mail_addresses AS a ON a.owner_user_id = o.user_id
  JOIN mail_domains AS d ON d.id = a.domain_id AND d.owner_user_id = a.owner_user_id
  WHERE o.singleton = 1 AND o.user_id = ${sqliteText(ownerUserId)} AND a.id = ${sqliteText(addressId)};`;
}

export function buildMailIdentityBackfillCandidatesSql(
  target: MailIdentityBackfillTarget,
  afterId: string | null,
  limit: number
) {
  const cursorCondition = afterId ? `AND e.id > ${sqliteText(afterId)}` : '';
  return `SELECT e.id, e.owner_user_id, e."to" AS envelope_to, e.direction,
    e."timestamp" AS message_timestamp, e.created_at, e.mail_domain_id,
    e.mail_address_id, e.recipient_status
  FROM email_messages AS e
  WHERE e.direction = 'inbound'
    AND e.owner_user_id = ${sqliteText(target.ownerUserId)}
    AND lower(trim(e."to")) = lower(${sqliteText(target.addressEmail)})
    AND e.mail_address_id IS NULL
    AND (
      (e.recipient_status = 'legacy-unmapped' AND (e.mail_domain_id IS NULL OR e.mail_domain_id = ${sqliteText(target.domainId)}))
      OR (e.recipient_status = 'unregistered' AND e.mail_domain_id = ${sqliteText(target.domainId)})
    )
    ${cursorCondition}
  ORDER BY e.id COLLATE BINARY
  LIMIT ${Math.trunc(limit)};`;
}

export function buildMailIdentityBackfillConflictCountsSql(target: MailIdentityBackfillTarget) {
  return `SELECT
    COALESCE(SUM(CASE WHEN e.owner_user_id IS NULL THEN 1 ELSE 0 END), 0) AS unowned,
    COALESCE(SUM(CASE WHEN e.owner_user_id IS NOT NULL AND e.owner_user_id != ${sqliteText(target.ownerUserId)} THEN 1 ELSE 0 END), 0) AS other_owner,
    COALESCE(SUM(CASE WHEN e.owner_user_id = ${sqliteText(target.ownerUserId)} AND e.mail_address_id IS NOT NULL AND e.mail_address_id != ${sqliteText(target.addressId)} THEN 1 ELSE 0 END), 0) AS mapped_to_other_address,
    COALESCE(SUM(CASE WHEN e.owner_user_id = ${sqliteText(target.ownerUserId)} AND e.mail_address_id IS NULL AND e.mail_domain_id IS NOT NULL AND e.mail_domain_id != ${sqliteText(target.domainId)} THEN 1 ELSE 0 END), 0) AS domain_mismatch,
    COALESCE(SUM(CASE WHEN e.owner_user_id = ${sqliteText(target.ownerUserId)} AND NOT (
      (e.mail_address_id IS NULL AND (e.mail_domain_id IS NULL OR e.mail_domain_id = ${sqliteText(target.domainId)}) AND e.recipient_status = 'legacy-unmapped') OR
      COALESCE((e.mail_address_id IS NULL AND e.mail_domain_id = ${sqliteText(target.domainId)} AND e.recipient_status = 'unregistered'), 0) OR
      COALESCE((e.mail_address_id = ${sqliteText(target.addressId)} AND e.mail_domain_id = ${sqliteText(target.domainId)} AND e.recipient_status = 'managed'), 0)
    ) AND (e.mail_domain_id IS NULL OR e.mail_domain_id = ${sqliteText(target.domainId)})
      AND (e.mail_address_id IS NULL OR e.mail_address_id = ${sqliteText(target.addressId)}) THEN 1 ELSE 0 END), 0) AS state_mismatch,
    COALESCE(SUM(CASE WHEN e.owner_user_id = ${sqliteText(target.ownerUserId)} AND e.mail_address_id = ${sqliteText(target.addressId)} AND e.mail_domain_id = ${sqliteText(target.domainId)} AND e.recipient_status = 'managed' THEN 1 ELSE 0 END), 0) AS already_mapped
  FROM email_messages AS e
  WHERE e.direction = 'inbound' AND lower(trim(e."to")) = lower(${sqliteText(target.addressEmail)});`;
}

export function buildMailIdentityBackfillOutboundCountSql(ownerUserId: string) {
  return `SELECT COUNT(*) AS count FROM workspace_messages
    WHERE user_id = ${sqliteText(ownerUserId)} AND folder = 'sent' AND sender_address_id IS NULL;`;
}

export function buildMailIdentityBackfillDraftCountSql(ownerUserId: string) {
  return `SELECT COUNT(*) AS count FROM workspace_drafts
    WHERE user_id = ${sqliteText(ownerUserId)} AND deleted_at IS NULL AND sender_address_id IS NULL;`;
}

export function buildMailIdentityBackfillInspectSql(records: MailIdentityBackfillRecord[]) {
  if (!records.length) throw new Error('Cannot inspect an empty backfill record set.');
  const ids = records.map((record) => sqliteText(record.messageId)).join(', ');
  return `SELECT e.id, e.owner_user_id, e."to" AS envelope_to, e.direction,
    e."timestamp" AS message_timestamp, e.created_at, e.mail_domain_id,
    e.mail_address_id, e.recipient_status,
    s.user_id AS search_projection_owner_user_id,
    s.mail_address_id AS search_projection_address_id
  FROM email_messages AS e
  LEFT JOIN workspace_search_documents AS s
    ON s.entity_kind = 'inbound' AND s.entity_id = e.id AND s.user_id = e.owner_user_id
  WHERE e.id IN (${ids});`;
}

function recordCompareAndSet(record: MailIdentityBackfillRecord, target: MailIdentityBackfillTarget) {
  return [
    `id = ${sqliteText(record.messageId)}`,
    `owner_user_id = ${sqliteText(record.ownerUserId)}`,
    `"to" = ${sqliteText(record.envelopeTo)}`,
    `direction = 'inbound'`,
    `"timestamp" = ${sqliteText(record.timestamp)}`,
    `created_at = ${sqliteText(record.createdAt)}`,
    `mail_address_id IS NULL`,
    record.mailDomainId === null ? 'mail_domain_id IS NULL' : `mail_domain_id = ${sqliteText(record.mailDomainId)}`,
    `recipient_status = '${record.recipientStatus}'`,
    record.recipientStatus === 'legacy-unmapped'
      ? `(mail_domain_id IS NULL OR mail_domain_id = ${sqliteText(target.domainId)})`
      : `mail_domain_id = ${sqliteText(target.domainId)}`
  ].join(' AND ');
}

export function buildMailIdentityBackfillUpdateSql(target: MailIdentityBackfillTarget, records: MailIdentityBackfillRecord[]) {
  if (!records.length) throw new Error('Cannot build an apply statement without planned rows.');
  if (records.length > MAIL_IDENTITY_BACKFILL_MAX_BATCH) throw new Error('Apply batch exceeds the safety limit.');
  const predicates = records.map((record) => `(${recordCompareAndSet(record, target)})`).join('\n  OR ');
  return `UPDATE email_messages
SET mail_domain_id = ${sqliteText(target.domainId)},
    mail_address_id = ${sqliteText(target.addressId)},
    recipient_status = 'managed'
WHERE ${predicates};`;
}
