import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLocalWranglerEnvironment } from './wrangler-environment';
import {
  MAX_ATTACHMENT_INTEGRITY_BYTES,
  repairInboundAttachmentChecksums,
  sha256Hex,
  type AttachmentRepairResult,
  type AttachmentRepairStatus
} from '$lib/server/attachment-integrity';

const MAX_REPAIR_LIMIT = 500;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,256}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

export const attachmentIntegrityUsage = `Usage: bun scripts/attachment-integrity.ts [options]

Options:
  --apply                 Persist repairs (default is report-only)
  --remote                Select the Preview resources in an explicit config
  --config <path>         Wrangler config path (default: wrangler.toml)
  --database <binding>    D1 binding/name (default: DB)
  --limit <1..500>        Maximum rows to inspect (default: 100)
  --cursor <attachment>   Resume after an attachment ID
  --repair-mismatches     Permit replacing an existing, incorrect digest
  --json                  Print a machine-readable report
  --help                  Show this help

Local execution uses the checked-in development bindings. Remote execution is
limited to an explicit APP_ENV=preview config and its preview resources.
Production configs are always refused. Object keys and message content are
never included in reports.
`;

export interface AttachmentIntegrityCliOptions {
  apply: boolean;
  remote: boolean;
  json: boolean;
  repairMismatches: boolean;
  config: string;
  database: string;
  limit: number;
  cursor: string | null;
  help: boolean;
}

export class AttachmentIntegrityCliError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AttachmentIntegrityCliError';
  }
}

type ValueFlag = '--config' | '--database' | '--limit' | '--cursor';

function readFlagValue(args: string[], index: number, flag: ValueFlag) {
  const inlinePrefix = `${flag}=`;
  const current = args[index];
  if (current.startsWith(inlinePrefix)) {
    const value = current.slice(inlinePrefix.length);
    if (!value || value.startsWith('--')) throw new AttachmentIntegrityCliError('INVALID_ARGUMENT', `${flag} requires a value.`);
    return { value, nextIndex: index };
  }
  if (current !== flag) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new AttachmentIntegrityCliError('INVALID_ARGUMENT', `${flag} requires a value.`);
  return { value, nextIndex: index + 1 };
}

function parseLimit(value: string) {
  if (!/^\d+$/u.test(value)) throw new AttachmentIntegrityCliError('INVALID_LIMIT', '--limit must be an integer from 1 to 500.');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REPAIR_LIMIT) {
    throw new AttachmentIntegrityCliError('INVALID_LIMIT', '--limit must be an integer from 1 to 500.');
  }
  return limit;
}

export function parseAttachmentIntegrityArgs(args: string[]): AttachmentIntegrityCliOptions {
  const options: AttachmentIntegrityCliOptions = {
    apply: false,
    remote: false,
    json: false,
    repairMismatches: false,
    config: 'wrangler.toml',
    database: 'DB',
    limit: 100,
    cursor: null,
    help: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help') { options.help = true; continue; }
    if (arg === '--apply') { options.apply = true; continue; }
    if (arg === '--remote') { options.remote = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--repair-mismatches') { options.repairMismatches = true; continue; }
    let handled = false;
    for (const flag of ['--config', '--database', '--limit', '--cursor'] as ValueFlag[]) {
      const result = readFlagValue(args, index, flag);
      if (!result) continue;
      handled = true;
      index = result.nextIndex;
      if (flag === '--config') options.config = result.value;
      else if (flag === '--database') options.database = result.value;
      else if (flag === '--limit') options.limit = parseLimit(result.value);
      else {
        if (!SAFE_IDENTIFIER.test(result.value)) throw new AttachmentIntegrityCliError('INVALID_CURSOR', '--cursor must be a bounded attachment ID.');
        options.cursor = result.value;
      }
      break;
    }
    if (!handled) throw new AttachmentIntegrityCliError('INVALID_ARGUMENT', 'Unknown attachment-integrity option.');
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(options.database)) {
    throw new AttachmentIntegrityCliError('INVALID_DATABASE', '--database must be a bounded binding name.');
  }
  if (!options.remote && /(?:^|[\\/])wrangler\.deploy\.toml$/u.test(options.config)) {
    throw new AttachmentIntegrityCliError('REMOTE_EXPLICIT', 'The deployment config requires explicit --remote.');
  }
  return options;
}

function isProductionTarget(options: AttachmentIntegrityCliOptions, environment: Record<string, string | undefined>) {
  const appEnv = environment.APP_ENV?.trim().toLowerCase();
  return appEnv === 'production' || /(?:^|[\\/])wrangler\.deploy\.toml$/u.test(options.config);
}

export function assertAttachmentIntegrityTarget(
  options: AttachmentIntegrityCliOptions,
  environment: Record<string, string | undefined> = process.env
) {
  if (isProductionTarget(options, environment)) {
    throw new AttachmentIntegrityCliError(
      'PRODUCTION_REFUSED',
      'Production attachment repair is refused by this CLI; use a separately reviewed operator workflow.'
    );
  }
}

export interface AttachmentIntegrityBindings {
  db: D1Database;
  bucket: R2Bucket;
}

export interface AttachmentCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type AttachmentCommandRunner = (
  executable: string,
  args: string[],
  environment: Record<string, string | undefined>
) => Promise<AttachmentCommandResult>;

export type AttachmentObjectReader = (
  bucket: string,
  key: string,
  options: AttachmentIntegrityCliOptions,
  environment: Record<string, string | undefined>
) => Promise<{ status: 'ok'; bytes: Uint8Array } | { status: 'missing' | 'storage_error' | 'too_large' }>;

export interface AttachmentIntegrityCliDependencies {
  bindings?: AttachmentIntegrityBindings;
  environment?: Record<string, string | undefined>;
  repair?: typeof repairInboundAttachmentChecksums;
  commandRunner?: AttachmentCommandRunner;
  objectReader?: AttachmentObjectReader;
  configSource?: string;
}

interface WranglerAttachmentRow {
  id: string;
  user_id: string;
  message_id: string;
  raw_key: string;
  r2_key: string;
  size: number;
  sha256: string | null;
}

function tomlSection(source: string, name: string) {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === `[${name}]`);
  if (start < 0) return '';
  const output: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/u.test(lines[index])) break;
    output.push(lines[index]);
  }
  return output.join('\n');
}

function tomlString(source: string, key: string) {
  return source.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, 'mu'))?.[1] ?? null;
}

function r2BindingBlock(source: string) {
  return source.split(/^\[\[r2_buckets\]\]\s*$/mu).slice(1)
    .map((part) => part.split(/^\[\[/mu, 1)[0])
    .find((block) => tomlString(block, 'binding') === 'BUCKET') ?? '';
}

function readWranglerTarget(source: string, options: AttachmentIntegrityCliOptions) {
  const appEnv = tomlString(tomlSection(source, 'vars'), 'APP_ENV')?.toLowerCase() ?? null;
  assertAttachmentIntegrityTarget(options, { APP_ENV: appEnv ?? undefined });
  if (options.remote && appEnv !== 'preview') {
    throw new AttachmentIntegrityCliError('PREVIEW_REQUIRED', 'Remote attachment integrity requires an explicit APP_ENV=preview config.');
  }
  if (!options.remote && appEnv !== 'development' && appEnv !== 'test') {
    throw new AttachmentIntegrityCliError('LOCAL_CONFIG_REQUIRED', 'Local attachment integrity requires an APP_ENV=development or test config.');
  }
  const block = r2BindingBlock(source);
  const bucket = tomlString(block, options.remote ? 'preview_bucket_name' : 'bucket_name');
  if (!bucket || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/u.test(bucket)) {
    throw new AttachmentIntegrityCliError('R2_BINDING_INVALID', 'The selected BUCKET binding is missing or invalid.');
  }
  return { appEnv, bucket };
}

function sqlLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function selectSql(options: AttachmentIntegrityCliOptions) {
  const cursor = options.cursor ? ` AND a.id > ${sqlLiteral(options.cursor)}` : '';
  return `SELECT a.id, a.user_id, a.message_id, e.raw_key, a.r2_key, a.size, a.sha256
FROM workspace_attachments AS a
JOIN email_messages AS e ON e.id = a.message_id AND e.owner_user_id = a.user_id
WHERE a.relation_type = 'inbound' AND a.state = 'ready'${cursor}
ORDER BY a.id ASC LIMIT ${options.limit}`;
}

function parseD1Results(stdout: string): Array<Record<string, unknown>> {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch {
    throw new AttachmentIntegrityCliError('D1_RESPONSE_INVALID', 'Wrangler returned an invalid D1 response.');
  }
  if (!Array.isArray(value)) throw new AttachmentIntegrityCliError('D1_RESPONSE_INVALID', 'Wrangler returned an invalid D1 response.');
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const results = (entry as { results?: unknown }).results;
    return Array.isArray(results) ? results.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object') : [];
  });
}

function parseAttachmentRow(value: Record<string, unknown>): WranglerAttachmentRow | null {
  const row = value as Partial<WranglerAttachmentRow>;
  if (![row.id, row.user_id, row.message_id, row.raw_key, row.r2_key].every((item) => typeof item === 'string')) return null;
  if (!Number.isSafeInteger(row.size) || (row.size as number) < 0) return null;
  if (row.sha256 !== null && typeof row.sha256 !== 'string') return null;
  return row as WranglerAttachmentRow;
}

function isOwnedInboundObject(row: WranglerAttachmentRow) {
  if (!SAFE_IDENTIFIER.test(row.id) || !SAFE_IDENTIFIER.test(row.user_id) || !SAFE_IDENTIFIER.test(row.message_id)) return false;
  const rawMatch = row.raw_key.match(/^(inbound\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._:-]{1,256})\/message\.eml$/u);
  if (!rawMatch || row.r2_key.length > 1024 || /[\u0000-\u001f\u007f]/u.test(row.r2_key)) return false;
  const prefix = `${rawMatch[1]}/attachments/${row.id}/`;
  const filename = row.r2_key.slice(prefix.length);
  return row.r2_key.startsWith(prefix) && filename.length > 0 && !filename.includes('/');
}

export async function runAttachmentCommand(
  executable: string,
  args: string[],
  environment: Record<string, string | undefined>
): Promise<AttachmentCommandResult> {
  const child = Bun.spawn([executable, ...args], { env: environment as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  return { exitCode, stdout, stderr };
}

export async function readAttachmentObjectWithWrangler(
  bucket: string,
  key: string,
  options: AttachmentIntegrityCliOptions,
  environment: Record<string, string | undefined>
): Promise<{ status: 'ok'; bytes: Uint8Array } | { status: 'missing' | 'storage_error' | 'too_large' }> {
  const args = ['x', 'wrangler', 'r2', 'object', 'get', `${bucket}/${key}`, '--pipe', '--config', options.config, options.remote ? '--remote' : '--local'];
  const child = Bun.spawn(['bun', ...args], { env: environment as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let tooLarge = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ATTACHMENT_INTEGRITY_BYTES) {
      tooLarge = true;
      child.kill();
      break;
    }
    chunks.push(value);
  }
  const stderr = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  if (tooLarge) return { status: 'too_large' };
  if (exitCode !== 0) return { status: /not found|does not exist|10007/iu.test(stderr) ? 'missing' : 'storage_error' };
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { status: 'ok', bytes };
}

function d1Args(options: AttachmentIntegrityCliOptions, sql: string) {
  return ['x', 'wrangler', 'd1', 'execute', options.database, '--command', sql, '--json', '--yes', '--config', options.config, options.remote ? '--preview' : '--local'];
}

async function updateDigest(
  row: WranglerAttachmentRow,
  digest: string,
  options: AttachmentIntegrityCliOptions,
  runner: AttachmentCommandRunner,
  environment: Record<string, string | undefined>
) {
  const checksumGuard = row.sha256 === null ? 'sha256 IS NULL' : `sha256 = ${sqlLiteral(row.sha256)}`;
  const sql = `UPDATE workspace_attachments SET sha256 = ${sqlLiteral(digest)}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ${sqlLiteral(row.id)} AND user_id = ${sqlLiteral(row.user_id)} AND message_id = ${sqlLiteral(row.message_id)} AND relation_type = 'inbound' AND ${checksumGuard}`;
  const result = await runner('bun', d1Args(options, sql), environment);
  if (result.exitCode !== 0) return false;
  let envelope: unknown;
  try { envelope = JSON.parse(result.stdout); } catch { return false; }
  return Array.isArray(envelope) && envelope.some((entry) => Number((entry as { meta?: { changes?: unknown } })?.meta?.changes ?? 0) === 1);
}

async function runWranglerAttachmentIntegrity(
  options: AttachmentIntegrityCliOptions,
  dependencies: AttachmentIntegrityCliDependencies,
  environment: Record<string, string | undefined>
): Promise<AttachmentRepairResult> {
  let configSource: string;
  try { configSource = dependencies.configSource ?? await readFile(resolve(options.config), 'utf8'); } catch {
    throw new AttachmentIntegrityCliError('CONFIG_UNAVAILABLE', 'The selected Wrangler config could not be read.');
  }
  const { bucket } = readWranglerTarget(configSource, options);
  const runner = dependencies.commandRunner ?? runAttachmentCommand;
  const objectReader = dependencies.objectReader ?? readAttachmentObjectWithWrangler;
  const query = await runner('bun', d1Args(options, selectSql(options)), environment);
  if (query.exitCode !== 0) throw new AttachmentIntegrityCliError('D1_QUERY_FAILED', 'The bounded attachment query failed.');
  const rows = parseD1Results(query.stdout);
  const output: AttachmentRepairResult['rows'] = [];
  let updated = 0;

  for (const rawRow of rows) {
    const row = parseAttachmentRow(rawRow);
    if (!row || !isOwnedInboundObject(row)) {
      output.push({ id: typeof rawRow.id === 'string' && SAFE_IDENTIFIER.test(rawRow.id) ? rawRow.id : 'invalid', messageId: typeof rawRow.message_id === 'string' && SAFE_IDENTIFIER.test(rawRow.message_id) ? rawRow.message_id : 'invalid', status: 'storage_error' });
      continue;
    }
    if (row.size > MAX_ATTACHMENT_INTEGRITY_BYTES) {
      output.push({ id: row.id, messageId: row.message_id, status: 'too_large' });
      continue;
    }
    const object = await objectReader(bucket, row.r2_key, options, environment);
    if (object.status !== 'ok') {
      output.push({ id: row.id, messageId: row.message_id, status: object.status });
      continue;
    }
    if (object.bytes.byteLength !== row.size) {
      output.push({ id: row.id, messageId: row.message_id, status: 'size_mismatch' });
      continue;
    }
    const digest = await sha256Hex(object.bytes);
    const expected = row.sha256?.trim().toLowerCase() ?? null;
    const legacy = expected === null;
    const mismatch = !legacy && (!SHA256_HEX.test(expected) || digest !== expected);
    if (!legacy && !mismatch) {
      output.push({ id: row.id, messageId: row.message_id, status: 'verified' });
      continue;
    }
    const repairAllowed = legacy || options.repairMismatches;
    let status: AttachmentRepairStatus = legacy ? 'legacy' : 'checksum_mismatch';
    if (options.apply && repairAllowed) {
      const changed = await updateDigest(row, digest, options, runner, environment);
      status = changed ? 'updated' : 'update_failed';
      if (changed) updated += 1;
    }
    output.push({ id: row.id, messageId: row.message_id, status });
  }
  const validRows = rows.map(parseAttachmentRow).filter((row): row is WranglerAttachmentRow => row !== null);
  return { scanned: rows.length, updated, rows: output, nextCursor: validRows.at(-1)?.id ?? null };
}

/** Run the bounded integrity audit through injected Worker bindings or Wrangler. */
export async function runAttachmentIntegrityCli(
  options: AttachmentIntegrityCliOptions,
  dependencies: AttachmentIntegrityCliDependencies = {}
): Promise<AttachmentRepairResult> {
  const environment = createLocalWranglerEnvironment(dependencies.environment ?? process.env);
  assertAttachmentIntegrityTarget(options, environment);
  if (dependencies.bindings) {
    const repair = dependencies.repair ?? repairInboundAttachmentChecksums;
    return repair(dependencies.bindings.db, dependencies.bindings.bucket, {
      limit: options.limit,
      afterId: options.cursor,
      apply: options.apply,
      repairMismatches: options.repairMismatches
    });
  }
  return runWranglerAttachmentIntegrity(options, dependencies, environment);
}

function printReport(report: AttachmentRepairResult, json: boolean) {
  if (json) {
    console.log(JSON.stringify(report));
    return;
  }
  console.log(`scanned=${report.scanned} updated=${report.updated} nextCursor=${report.nextCursor ?? 'none'}`);
  for (const row of report.rows) console.log(`${row.id} ${row.status}`);
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  let options: AttachmentIntegrityCliOptions | undefined;
  try {
    options = parseAttachmentIntegrityArgs(args);
    if (options.help) {
      console.log(attachmentIntegrityUsage);
      return 0;
    }
    const report = await runAttachmentIntegrityCli(options, { environment });
    printReport(report, options.json);
    return 0;
  } catch (error) {
    const cliError = error instanceof AttachmentIntegrityCliError
      ? error
      : new AttachmentIntegrityCliError('ATTACHMENT_INTEGRITY_FAILED', 'Attachment integrity operation was not completed.');
    if (options?.json || args.includes('--json')) console.log(JSON.stringify({ ok: false, code: cliError.code }));
    else console.error(`${cliError.code}: ${cliError.message}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
