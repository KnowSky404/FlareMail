import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { extractD1Rows } from './bootstrap-owner';
import {
  applyMailIdentityBackfillPlan,
  buildMailIdentityBackfillCandidatesSql,
  buildMailIdentityBackfillConflictCountsSql,
  buildMailIdentityBackfillDraftCountSql,
  buildMailIdentityBackfillInspectSql,
  buildMailIdentityBackfillOutboundCountSql,
  buildMailIdentityBackfillSchemaVersionSql,
  buildMailIdentityBackfillTargetSql,
  buildMailIdentityBackfillUpdateSql,
  createMailIdentityBackfillPlan,
  parseMailIdentityBackfillArguments,
  validateMailIdentityBackfillPlan,
  verifyMailIdentityBackfillPlan,
  type MailIdentityBackfillObservedRecord,
  type MailIdentityBackfillRecord,
  type MailIdentityBackfillStore,
  type MailIdentityBackfillTarget
} from './mail-identity-backfill-core';
import { createLocalWranglerEnvironment } from './wrangler-environment';

const planFileMaxBytes = 1_000_000;

function nullableString(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function localStore(persistTo: string): MailIdentityBackfillStore {
  const localStatePath = resolve(persistTo);
  const environment = createLocalWranglerEnvironment();

  async function execute(sql: string, mutating = false) {
    const child = Bun.spawn([
      'bun', 'x', 'wrangler', 'd1', 'execute', 'flaremail-db',
      '--local', '--config', 'wrangler.toml', '--persist-to', localStatePath, '--json',
      ...(mutating ? ['--yes'] : []), '--command', sql
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: environment
    });
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (exitCode !== 0) throw new Error('Wrangler local D1 command failed; no remote target is supported.');
    return extractD1Rows(stdout);
  }

  return {
    executionTarget: {
      mode: 'local',
      database: 'flaremail-db',
      config: 'wrangler.toml',
      persistTo: localStatePath
    },
    async getSchemaVersion() {
      const rows = await execute(buildMailIdentityBackfillSchemaVersionSql());
      return rows.length ? numberValue(rows[0]?.schema_version) : null;
    },
    async getTarget(ownerUserId, addressId) {
      const rows = await execute(buildMailIdentityBackfillTargetSql(ownerUserId, addressId));
      const row = rows[0];
      if (!row || row.owner_user_id !== ownerUserId || row.workspace_user_id !== ownerUserId ||
          row.address_owner_user_id !== ownerUserId || row.domain_owner_user_id !== ownerUserId) return null;
      return {
        ownerUserId,
        addressId: String(row.address_id),
        addressEmail: String(row.address_email),
        domainId: String(row.joined_domain_id),
        domainName: String(row.domain_name)
      } satisfies MailIdentityBackfillTarget;
    },
    async findCandidates(target, afterId, limit) {
      const rows = await execute(buildMailIdentityBackfillCandidatesSql(target, afterId, limit));
      return rows.map((row) => ({
        messageId: String(row.id),
        ownerUserId: String(row.owner_user_id),
        envelopeTo: String(row.envelope_to),
        direction: 'inbound',
        timestamp: String(row.message_timestamp),
        createdAt: String(row.created_at),
        mailDomainId: nullableString(row.mail_domain_id),
        mailAddressId: null,
        recipientStatus: String(row.recipient_status) as MailIdentityBackfillRecord['recipientStatus']
      }));
    },
    async getConflictCounts(target) {
      const rows = await execute(buildMailIdentityBackfillConflictCountsSql(target));
      const row = rows[0] ?? {};
      return {
        unowned: numberValue(row.unowned),
        otherOwner: numberValue(row.other_owner),
        mappedToOtherAddress: numberValue(row.mapped_to_other_address),
        domainMismatch: numberValue(row.domain_mismatch),
        stateMismatch: numberValue(row.state_mismatch),
        alreadyMapped: numberValue(row.already_mapped)
      };
    },
    async countUnmappedOutbound(ownerUserId) {
      const rows = await execute(buildMailIdentityBackfillOutboundCountSql(ownerUserId));
      return numberValue(rows[0]?.count);
    },
    async countDraftsWithoutSender(ownerUserId) {
      const rows = await execute(buildMailIdentityBackfillDraftCountSql(ownerUserId));
      return numberValue(rows[0]?.count);
    },
    async inspect(records) {
      if (!records.length) return [];
      const rows = await execute(buildMailIdentityBackfillInspectSql(records));
      return rows.map((row) => ({
        messageId: String(row.id),
        ownerUserId: String(row.owner_user_id),
        envelopeTo: String(row.envelope_to),
        direction: 'inbound',
        timestamp: String(row.message_timestamp),
        createdAt: String(row.created_at),
        mailDomainId: nullableString(row.mail_domain_id),
        mailAddressId: nullableString(row.mail_address_id),
        recipientStatus: String(row.recipient_status) as MailIdentityBackfillObservedRecord['recipientStatus'],
        searchProjectionOwnerUserId: nullableString(row.search_projection_owner_user_id),
        searchProjectionAddressId: nullableString(row.search_projection_address_id)
      }));
    },
    async applyUpdate(target, records) {
      await execute(buildMailIdentityBackfillUpdateSql(target, records), true);
    }
  };
}

async function readPlan(path: string) {
  const filePath = resolve(path);
  const metadata = await stat(filePath);
  if (metadata.size > planFileMaxBytes) throw new Error('Plan file exceeds the 1 MB safety limit.');
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  return validateMailIdentityBackfillPlan(parsed);
}

function shortReport(plan: Awaited<ReturnType<typeof createMailIdentityBackfillPlan>>) {
  return {
    command: 'plan',
    mode: 'local-read-only',
    planPathWritten: true,
    planVersion: plan.planVersion,
    schemaVersion: plan.schemaVersion,
    target: plan.target,
    plannedCount: plan.selection.plannedCount,
    hasMore: plan.selection.hasMore,
    nextAfterId: plan.selection.nextAfterId,
    conflicts: plan.conflicts,
    excluded: plan.excluded,
    expiresAt: plan.expiresAt,
    digest: plan.digest
  };
}

async function main() {
  const options = parseMailIdentityBackfillArguments(process.argv.slice(2));
  const persistTo = resolve(options.persistTo);
  await mkdir(persistTo, { recursive: true });
  const store = localStore(persistTo);

  if (options.command === 'plan') {
    const plan = await createMailIdentityBackfillPlan(store, {
      ownerUserId: options.ownerUserId!,
      addressId: options.addressId!,
      ...(options.afterId ? { afterId: options.afterId } : {}),
      limit: options.limit
    });
    const outputPath = resolve(options.outputPath!);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(plan, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify(shortReport(plan), null, 2));
    return;
  }

  const plan = await readPlan(options.planPath!);
  const result = options.command === 'apply'
    ? await applyMailIdentityBackfillPlan(store, plan, options.confirm!)
    : await verifyMailIdentityBackfillPlan(store, plan);
  console.log(JSON.stringify({ mode: 'local', ...result }, null, 2));
  if (result.status !== 'complete') process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Local mail identity backfill failed.');
    process.exitCode = 1;
  });
}
