import { readFile } from 'node:fs/promises';

type MaintenanceOptions = {
  remote: boolean;
  apply: boolean;
  json: boolean;
  config: string;
  database: string;
  bucket: string;
  sessionRetentionDays: number;
  webhookRetentionDays: number;
  r2Manifest: string | null;
};

type R2Object = { key: string; size?: number; uploaded?: string };

type MaintenanceReport = {
  mode: 'dry-run' | 'apply';
  target: 'local' | 'remote';
  cutoffs: { sessions: string; webhookEvents: string };
  sessions: { candidates: number; deleted: number };
  webhookEvents: { candidates: number; deleted: number };
  r2: {
    inventory: 'manifest' | 'unavailable';
    referenced: number;
    objects: number | null;
    orphaned: number | null;
    deleted: number;
    skippedUnsafeDeletes: number;
    keys: string[];
    note?: string;
  };
};

const usage = `Usage: bun scripts/maintenance.ts [options]

Options:
  --remote                       Target remote D1/R2 (default: local)
  --apply                        Apply deletes (requires explicit --apply)
  --config <path>               Wrangler config path
  --database <name>             D1 database name (default: flaremail-db)
  --bucket <name>               R2 bucket name (default: flaremail-bucket)
  --session-retention-days <n>  Keep revoked/expired sessions for n days (default: 30)
  --webhook-retention-days <n>  Keep webhook events for n days (default: 180)
  --r2-manifest <path>          JSON inventory of R2 objects (for offline/reviewed runs)
  --json                        Print machine-readable output
  --help                        Show this help

R2 cleanup always requires a separately reviewed JSON inventory. Without one,
R2 is reported as unavailable and no R2 deletion can occur.
`;

const hasFlag = (args: string[], flag: string) => args.includes(flag);

function optionValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function positiveDays(value: string | undefined, flag: string, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 36_500) {
    throw new Error(`${flag} must be an integer between 0 and 36500.`);
  }
  return parsed;
}

export function parseMaintenanceArgs(args: string[]): MaintenanceOptions {
  if (hasFlag(args, '--help')) {
    console.log(usage);
    process.exit(0);
  }
  const remote = hasFlag(args, '--remote');
  const apply = hasFlag(args, '--apply');
  const config = optionValue(args, '--config') ?? (remote ? 'wrangler.deploy.toml' : 'wrangler.toml');
  return {
    remote,
    apply,
    json: hasFlag(args, '--json'),
    config,
    database: optionValue(args, '--database') ?? 'flaremail-db',
    bucket: optionValue(args, '--bucket') ?? 'flaremail-bucket',
    sessionRetentionDays: positiveDays(optionValue(args, '--session-retention-days'), '--session-retention-days', 30),
    webhookRetentionDays: positiveDays(optionValue(args, '--webhook-retention-days'), '--webhook-retention-days', 180),
    r2Manifest: optionValue(args, '--r2-manifest') ?? null
  };
}

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function cutoffIso(now = new Date(), retentionDays: number) {
  return new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
}

export function maintenanceSql(cutoffs: { sessions: string; webhookEvents: string }) {
  const sessionCutoff = sqlLiteral(cutoffs.sessions);
  const webhookCutoff = sqlLiteral(cutoffs.webhookEvents);
  return {
    sessionCandidates: `SELECT COUNT(*) AS count FROM workspace_sessions WHERE (revoked_at IS NOT NULL AND datetime(revoked_at) <= datetime(${sessionCutoff})) OR (expires_at IS NOT NULL AND datetime(expires_at) <= datetime(${sessionCutoff}))`,
    webhookCandidates: `SELECT COUNT(*) AS count FROM workspace_outbound_events WHERE datetime(created_at) <= datetime(${webhookCutoff})`,
    references: `SELECT raw_key AS key FROM email_messages WHERE raw_key <> '' UNION SELECT r2_key AS key FROM workspace_attachments WHERE r2_key <> ''`,
    apply: `DELETE FROM workspace_sessions WHERE (revoked_at IS NOT NULL AND datetime(revoked_at) <= datetime(${sessionCutoff})) OR (expires_at IS NOT NULL AND datetime(expires_at) <= datetime(${sessionCutoff})); DELETE FROM workspace_outbound_events WHERE datetime(created_at) <= datetime(${webhookCutoff});`
  };
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        // Wrangler may print a progress line before its JSON result.
      }
    }
  }
  throw new Error('The command did not return valid JSON.');
}

export function d1Rows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => d1Rows(item));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.results)) return record.results;
  if (Array.isArray(record.result)) return record.result.flatMap((item) => d1Rows(item));
  return [];
}

export function d1Count(value: unknown) {
  const row = d1Rows(value)[0];
  if (!row || typeof row !== 'object') return 0;
  const count = Number((row as Record<string, unknown>).count);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function d1Changes(value: unknown) {
  const values = Array.isArray(value) ? value : [value];
  return values.reduce((total, item) => {
    if (!item || typeof item !== 'object') return total;
    const meta = (item as Record<string, unknown>).meta;
    if (!meta || typeof meta !== 'object') return total;
    const changes = Number((meta as Record<string, unknown>).changes);
    return total + (Number.isSafeInteger(changes) && changes >= 0 ? changes : 0);
  }, 0);
}

export function referencedKeys(value: unknown) {
  return new Set(d1Rows(value).flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const key = (row as Record<string, unknown>).key;
    return typeof key === 'string' && key.length > 0 ? [key] : [];
  }));
}

export function orphanKeys(objects: R2Object[], references: Set<string>) {
  const seen = new Set<string>();
  return objects.filter((object) => {
    if (!object.key || references.has(object.key) || seen.has(object.key)) return false;
    seen.add(object.key);
    return true;
  });
}

export function isManagedR2Key(key: string) {
  return /^inbound\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_-]+(?:\/message\.eml|\/attachments\/[A-Za-z0-9_-]+\/[^/]+)$/u.test(key);
}

async function runWrangler(args: string[]) {
  const child = Bun.spawn(['bun', 'x', 'wrangler', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || '/tmp' }
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  if (exitCode !== 0) {
    void stderr;
    throw new Error(`Wrangler command failed with exit code ${exitCode}.`);
  }
  return stdout;
}

async function executeD1(options: MaintenanceOptions, sql: string, write = false) {
  const args = ['d1', 'execute', options.database, options.remote ? '--remote' : '--local', '--config', options.config, '--command', sql, '--json'];
  if (write) args.push('--yes');
  return parseJsonOutput(await runWrangler(args));
}

function manifestKeys(value: unknown): R2Object[] {
  const source = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).objects)
    ? (value as Record<string, unknown>).objects
    : [];
  return source.flatMap((item) => {
    if (typeof item === 'string') return [{ key: item }];
    if (!item || typeof item !== 'object' || typeof (item as Record<string, unknown>).key !== 'string') return [];
    const record = item as Record<string, unknown>;
    return [{ key: record.key as string, ...(typeof record.size === 'number' ? { size: record.size } : {}), ...(typeof record.uploaded === 'string' ? { uploaded: record.uploaded } : {}) }];
  });
}

async function readManifest(path: string) {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Unable to read R2 manifest: ${path}.`);
  }
  try {
    return manifestKeys(JSON.parse(content));
  } catch {
    throw new Error(`R2 manifest is not valid JSON: ${path}.`);
  }
}

async function listR2Objects(options: MaintenanceOptions): Promise<{ inventory: MaintenanceReport['r2']['inventory']; objects: R2Object[]; note?: string }> {
  if (options.r2Manifest) return { inventory: 'manifest', objects: await readManifest(options.r2Manifest) };
  return {
    inventory: 'unavailable',
    objects: [],
    note: 'R2 orphan analysis requires a reviewed --r2-manifest inventory.'
  };
}

async function deleteR2Objects(options: MaintenanceOptions, objects: R2Object[]) {
  let deleted = 0;
  let skippedUnsafeDeletes = 0;
  for (const object of objects) {
    if (!isManagedR2Key(object.key)) {
      skippedUnsafeDeletes += 1;
      continue;
    }
    await runWrangler(['r2', 'object', 'delete', `${options.bucket}/${object.key}`, options.remote ? '--remote' : '--local', '--config', options.config]);
    deleted += 1;
  }
  return { deleted, skippedUnsafeDeletes };
}

function reportOutput(report: MaintenanceReport, json: boolean) {
  if (json) return console.log(JSON.stringify(report));
  console.log(`Maintenance ${report.mode} (${report.target})`);
  console.log(`Sessions: ${report.sessions.candidates} candidate(s), ${report.sessions.deleted} deleted.`);
  console.log(`Webhook events: ${report.webhookEvents.candidates} candidate(s), ${report.webhookEvents.deleted} deleted.`);
  if (report.r2.objects === null) console.log(`R2: inventory unavailable (${report.r2.note ?? 'no inventory'}).`);
  else console.log(`R2: ${report.r2.objects} object(s), ${report.r2.orphaned} orphan(s), ${report.r2.deleted} deleted.`);
  if (report.r2.keys.length > 0) console.log(`R2 orphan keys: ${report.r2.keys.join(', ')}`);
  if (report.r2.skippedUnsafeDeletes > 0) console.log(`R2 skipped ${report.r2.skippedUnsafeDeletes} unmanaged object(s).`);
}

export async function runMaintenance(options: MaintenanceOptions) {
  const cutoffs = {
    sessions: cutoffIso(new Date(), options.sessionRetentionDays),
    webhookEvents: cutoffIso(new Date(), options.webhookRetentionDays)
  };
  const sql = maintenanceSql(cutoffs);
  const [sessionCount, webhookCount, referencesResult, r2Inventory] = await Promise.all([
    executeD1(options, sql.sessionCandidates),
    executeD1(options, sql.webhookCandidates),
    executeD1(options, sql.references),
    listR2Objects(options)
  ]);
  const references = referencedKeys(referencesResult);
  const orphaned = r2Inventory.inventory === 'unavailable' ? [] : orphanKeys(r2Inventory.objects, references);
  const applyD1 = options.apply
    ? await Promise.all([
      executeD1(options, sql.apply.split(';')[0], true),
      executeD1(options, sql.apply.split(';')[1], true)
    ])
    : null;
  const r2DeleteResult = options.apply && r2Inventory.inventory !== 'unavailable'
    ? await deleteR2Objects(options, orphaned)
    : { deleted: 0, skippedUnsafeDeletes: 0 };
  const report: MaintenanceReport = {
    mode: options.apply ? 'apply' : 'dry-run',
    target: options.remote ? 'remote' : 'local',
    cutoffs,
    sessions: { candidates: d1Count(sessionCount), deleted: options.apply ? d1Changes(applyD1?.[0]) : 0 },
    webhookEvents: { candidates: d1Count(webhookCount), deleted: options.apply ? d1Changes(applyD1?.[1]) : 0 },
    r2: {
      inventory: r2Inventory.inventory,
      referenced: references.size,
      objects: r2Inventory.inventory === 'unavailable' ? null : r2Inventory.objects.length,
      orphaned: r2Inventory.inventory === 'unavailable' ? null : orphaned.length,
      deleted: r2DeleteResult.deleted,
      skippedUnsafeDeletes: r2DeleteResult.skippedUnsafeDeletes,
      keys: orphaned.map((object) => object.key),
      ...(r2Inventory.note ? { note: r2Inventory.note } : {})
    }
  };
  return report;
}

if (import.meta.main) {
  try {
    const options = parseMaintenanceArgs(process.argv.slice(2));
    const report = await runMaintenance(options);
    reportOutput(report, options.json);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Maintenance failed.');
    process.exitCode = 1;
  }
}

export type { MaintenanceOptions, MaintenanceReport, R2Object };
