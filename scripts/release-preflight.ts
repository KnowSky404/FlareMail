import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';

export type PreflightStatus = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
export type PreflightCategory =
  | 'bun'
  | 'git'
  | 'config'
  | 'bindings'
  | 'schema'
  | 'health'
  | 'fts'
  | 'cleanup'
  | 'checksum'
  | 'claims'
  | 'attachments'
  | 'delivery'
  | 'search'
  | 'install'
  | 'audit'
  | 'check'
  | 'typegen'
  | 'build';

export interface PreflightCheck {
  category: PreflightCategory;
  status: PreflightStatus;
  summary: string;
  details?: Record<string, string | number | boolean | null | string[]>;
}

export interface PreflightReport {
  version: 1;
  target: 'local';
  readOnly: true;
  ok: boolean;
  checks: PreflightCheck[];
}

export interface CommandResult {
  exitCode: number;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
}

export type CommandRunner = (
  executable: string,
  args: string[],
  options?: { timeoutMs?: number }
) => Promise<CommandResult>;

export interface PreflightOptions {
  projectRoot?: string;
  runCommands?: boolean;
  commandRunner?: CommandRunner;
  gitInspector?: GitInspector;
}

export interface GitState {
  exitCode: number;
  status: string;
  head: string;
}

export type GitInspector = (root: string) => Promise<GitState>;

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_COMMAND_ENV_KEYS = ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'CI', 'NODE_ENV'] as const;

function pass(category: PreflightCategory, summary: string, details?: PreflightCheck['details']): PreflightCheck {
  return { category, status: 'PASS', summary, ...(details ? { details } : {}) };
}

function skip(category: PreflightCategory, summary: string, details?: PreflightCheck['details']): PreflightCheck {
  return { category, status: 'SKIP', summary, ...(details ? { details } : {}) };
}

function fail(category: PreflightCategory, summary: string, details?: PreflightCheck['details']): PreflightCheck {
  return { category, status: 'FAIL', summary, ...(details ? { details } : {}) };
}

async function readText(root: string, relativePath: string) {
  return await readFile(join(root, relativePath), 'utf8');
}

function tomlValue(source: string, key: string) {
  return source.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"\\s*$`, 'mu'))?.[1] ?? null;
}

function hasBinding(source: string, binding: string) {
  return new RegExp(`^binding\\s*=\\s*"${binding}"\\s*$`, 'mu').test(source);
}

function hasAny(source: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(source));
}

function versionFromSource(source: string) {
  return Number(
    source.match(/schema_version\s*\)\s*VALUES\s*\(\s*'flaremail'\s*,\s*(\d+)/u)?.[1] ??
    source.match(/schema_version\s*=\s*(\d+)/u)?.[1] ??
    NaN
  );
}

function migrationVersion(file: string) {
  return Number(file.match(/^(\d{4})_/u)?.[1] ?? NaN);
}

function parseVersion(value: string) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/u);
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(actual: string, minimum: string) {
  const current = parseVersion(actual);
  const required = parseVersion(minimum);
  if (!current || !required) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== required[index]) return current[index] > required[index];
  }
  return true;
}

function safeCommandEnvironment() {
  const source = process.env;
  const environment: Record<string, string> = {};
  for (const key of SAFE_COMMAND_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  // Never inherit HOME/XDG config or any provider credentials. Wrangler is
  // only used by the typegen check and receives no authentication state.
  environment.CI ??= 'true';
  environment.NODE_ENV ??= 'test';
  environment.BUN_INSTALL_CACHE_DIR = join(tmpdir(), 'flaremail-preflight-bun-cache');
  return environment;
}

export async function runCommand(
  executable: string,
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<CommandResult> {
  const child = Bun.spawn([executable, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: safeCommandEnvironment()
  });
  const timeoutMs = options.timeoutMs ?? 120_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<void>((resolveTimeout) => {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      resolveTimeout();
    }, timeoutMs);
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  await Promise.race([child.exited, timeout]);
  if (timer) clearTimeout(timer);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return {
    exitCode: timedOut ? 124 : await child.exited,
    stdout,
    stderr,
    ...(timedOut ? { timedOut: true } : {})
  };
}

async function checkBun(root: string): Promise<PreflightCheck> {
  const packageJson = JSON.parse(await readText(root, 'package.json')) as {
    packageManager?: string;
    engines?: { bun?: string };
  };
  const version = process.versions.bun;
  const declared = packageJson.packageManager ?? '';
  const minimum = packageJson.engines?.bun ?? '';
  const declaredVersion = declared.startsWith('bun@') ? declared.slice(4) : '';
  const minimumVersion = minimum.startsWith('>=') ? minimum.slice(2) : '';
  if (!version || !declaredVersion || !minimumVersion || version !== declaredVersion || !versionAtLeast(version, minimumVersion)) {
    return fail('bun', 'Bun package metadata is incomplete.');
  }
  return pass('bun', `Bun ${version} is available.`, { version, packageManager: declared, engine: minimum });
}

export async function inspectGit(root: string, commandRunner: CommandRunner = runCommand): Promise<GitState> {
  const status = await commandRunner('git', ['-C', root, 'status', '--porcelain=v1']);
  const head = await commandRunner('git', ['-C', root, 'rev-parse', '--verify', 'HEAD']);
  return {
    exitCode: status.exitCode !== 0 ? status.exitCode : head.exitCode,
    status: status.stdout?.trim() ?? '',
    head: head.stdout?.trim() ?? ''
  };
}

async function checkGit(root: string, gitInspector: GitInspector): Promise<PreflightCheck> {
  const state = await gitInspector(root);
  if (state.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(state.head)) {
    return fail('git', 'Unable to determine the current commit from Git.');
  }
  if (state.status) {
    return fail('git', 'Git worktree is dirty; commit or discard changes before release preflight.', {
      head: state.head,
      dirty: true
    });
  }
  return pass('git', 'Git worktree is clean.', { head: state.head, dirty: false });
}

async function checkConfig(root: string): Promise<PreflightCheck> {
  const publicConfig = await readText(root, 'wrangler.toml');
  const deployExample = await readText(root, 'wrangler.deploy.toml.example');
  const publicEnv = tomlValue(publicConfig, 'APP_ENV');
  const publicProvider = tomlValue(publicConfig, 'OUTBOUND_PROVIDER');
  const deployEnv = tomlValue(deployExample, 'APP_ENV');
  const deployProvider = tomlValue(deployExample, 'OUTBOUND_PROVIDER');
  const compatibilityDate = tomlValue(publicConfig, 'compatibility_date');
  const deployCompatibilityDate = tomlValue(deployExample, 'compatibility_date');
  const appOrigin = tomlValue(deployExample, 'APP_ORIGIN');
  const resendBaseUrl = tomlValue(deployExample, 'RESEND_API_BASE_URL');
  const d1StructuralPlaceholder = /database_id\s*=\s*"0{8}-0{4}-0{4}-0{4}-0{12}"/u.test(publicConfig);
  const r2StructuralPlaceholder = /bucket_name\s*=\s*"flaremail-bucket"/u.test(publicConfig);
  const unsafeSecret = hasAny(`${publicConfig}\n${deployExample}`, [
    /(?:api[_-]?key|webhook[_-]?secret|cloudflare[_-]?api[_-]?token)\s*=\s*"(?!")/iu,
    /(?:sk|whsec)_[A-Za-z0-9._-]{8,}/u
  ]);
  const valid = publicEnv === 'development' && /^(demo|fake)$/u.test(publicProvider ?? '') &&
    deployEnv === 'production' && deployProvider === 'resend' &&
    /^\d{4}-\d{2}-\d{2}$/u.test(compatibilityDate ?? '') && compatibilityDate === deployCompatibilityDate &&
    Boolean(appOrigin?.startsWith('https://')) &&
    (!resendBaseUrl || resendBaseUrl === 'https://api.resend.com') &&
    d1StructuralPlaceholder && r2StructuralPlaceholder && !unsafeSecret;
  if (!valid) return fail('config', 'Checked-in development/deploy-example boundaries are invalid.');
  return pass('config', 'Checked-in configs are local-safe and production-fail-closed.', {
    localEnvironment: publicEnv,
    localProvider: publicProvider,
    exampleEnvironment: deployEnv,
    exampleProvider: deployProvider,
    compatibilityDate,
    appOriginConfigured: Boolean(appOrigin),
    officialResendOrigin: resendBaseUrl ?? 'https://api.resend.com',
    d1StructuralPlaceholder,
    r2StructuralPlaceholder,
    resendCredentialPresent: false,
    webhookCredentialPresent: false,
    fakeBoundary: true
  });
}

async function checkBindings(root: string): Promise<PreflightCheck> {
  const source = await readText(root, 'wrangler.toml');
  const required = ['ASSETS', 'DB', 'BUCKET'];
  const missing = required.filter((binding) => !hasBinding(source, binding));
  const hasPlaceholderD1 = /database_id\s*=\s*"0{8}-0{4}-0{4}-0{4}-0{12}"/u.test(source);
  const hasPlaceholderR2 = /bucket_name\s*=\s*"flaremail-bucket"/u.test(source);
  if (missing.length > 0 || !hasPlaceholderD1 || !hasPlaceholderR2) {
    return fail('bindings', 'Local Wrangler bindings are incomplete or not placeholder-only.', { missing, d1Placeholder: hasPlaceholderD1, r2Placeholder: hasPlaceholderR2 });
  }
  return pass('bindings', 'Local D1/R2/assets bindings are present with a non-production placeholder D1 ID.', {
    bindings: required,
    d1Placeholder: true,
    r2Placeholder: true,
    productionAccess: false
  });
}

function sqliteObjects(db: Database) {
  return db.query(`
    SELECT type, name FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all() as Array<{ type: string; name: string }>;
}

function sqliteTableColumns(db: Database, table: string) {
  const escaped = table.replaceAll('"', '""');
  return (db.query(`PRAGMA table_info("${escaped}")`).all() as Array<Record<string, unknown>>)
    .map(({ cid: _cid, ...column }) => column)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function sqliteIndexColumns(db: Database, index: string) {
  const escaped = index.replaceAll('"', '""');
  return (db.query(`PRAGMA index_info("${escaped}")`).all() as Array<Record<string, unknown>>)
    .map(({ seq: _seq, cid: _cid, ...column }) => column);
}

function sameSqliteShape(left: Database, right: Database) {
  const leftObjects = sqliteObjects(left);
  const rightObjects = sqliteObjects(right);
  if (JSON.stringify(leftObjects) !== JSON.stringify(rightObjects)) return false;
  for (const object of leftObjects) {
    if (object.type === 'table' && JSON.stringify(sqliteTableColumns(left, object.name)) !== JSON.stringify(sqliteTableColumns(right, object.name))) return false;
    if (object.type === 'index' && JSON.stringify(sqliteIndexColumns(left, object.name)) !== JSON.stringify(sqliteIndexColumns(right, object.name))) return false;
  }
  return true;
}

function healthTables(source: string) {
  const block = source.match(/const REQUIRED_TABLES = \[([\s\S]*?)\] as const/u)?.[1];
  return block ? [...block.matchAll(/'([^']+)'/gu)].map((match) => match[1]!) : [];
}

async function checkSchema(root: string): Promise<{ schema: PreflightCheck; health: PreflightCheck }> {
  const files = (await readdir(join(root, 'migrations')))
    .filter((file) => /^\d{4}_.+\.sql$/u.test(file))
    .sort();
  const versions = files.map(migrationVersion);
  const expected = versions.map((_, index) => index + 1);
  const latest = versions.at(-1) ?? NaN;
  const latestSql = files.length > 0 ? await readText(root, `migrations/${files.at(-1)}`) : '';
  const schemaVersionSource = await readText(root, 'src/lib/server/db/schema-version.ts');
  const declared = Number(schemaVersionSource.match(/=\s*(\d+)\s*;/u)?.[1] ?? NaN);
  const migrationMarker = versionFromSource(latestSql);
  let shapeAligned = false;
  let migratedTables: string[] = [];
  let snapshotTables: string[] = [];
  try {
    const migrated = new Database(':memory:');
    for (const file of files) migrated.exec(await readText(root, `migrations/${file}`));
    const snapshot = new Database(':memory:');
    snapshot.exec(await readText(root, 'schema.sql'));
    shapeAligned = sameSqliteShape(migrated, snapshot);
    migratedTables = sqliteObjects(migrated).filter(({ type }) => type === 'table').map(({ name }) => name);
    snapshotTables = sqliteObjects(snapshot).filter(({ type }) => type === 'table').map(({ name }) => name);
    migrated.close();
    snapshot.close();
  } catch {
    shapeAligned = false;
  }
  const aligned = files.length > 0 && JSON.stringify(versions) === JSON.stringify(expected) &&
    declared === latest && migrationMarker === latest && shapeAligned;
  const schema = aligned
    ? pass('schema', `Migration order, schema version ${latest}, and schema snapshot are aligned.`, { latest, migrationCount: files.length, snapshotAligned: true })
    : fail('schema', 'Migration order, schema version, or schema snapshot is inconsistent.', { latest, declared, migrationMarker, snapshotAligned: shapeAligned, files });
  const healthSource = await readText(root, 'src/routes/api/health/+server.ts');
  const required = healthTables(healthSource);
  const missing = required.filter((table) => !migratedTables.includes(table));
  const health = required.length > 0 && missing.length === 0 && JSON.stringify(migratedTables.sort()) === JSON.stringify(snapshotTables.sort())
    ? pass('health', 'Health readiness table contract exists in the migrated schema.', { requiredTables: required, missingTables: [] })
    : fail('health', 'Health readiness table contract is missing or diverges from the schema snapshot.', { requiredTables: required, missingTables: missing });
  return { schema, health };
}

async function checkStaticContract(root: string, category: PreflightCategory, summary: string, patterns: RegExp[]) {
  const files = category === 'checksum'
    ? ['schema.sql', 'src/routes/api/workspace/messages/[id]/attachments/[attachmentId]/+server.ts', 'src/lib/server/attachment-integrity.ts']
    : category === 'claims'
      ? ['schema.sql', 'scripts/maintenance.ts']
      : ['schema.sql', 'scripts/search-index.ts'];
  const sources = await Promise.all(files.map((file) => readText(root, file)));
  const present = patterns.every((pattern) => sources.some((source) => pattern.test(source)));
  if (!present) return fail(category, `${summary} static contract is incomplete.`);
  return pass(category, `${summary} static contract is present.`);
}

async function checkFts(root: string): Promise<PreflightCheck> {
  const schema = await readText(root, 'schema.sql');
  const search = await readText(root, 'scripts/search-index.ts');
  if (!/workspace_search_documents/u.test(schema) || !/workspace_search_fts/u.test(schema) || !/expected_documents/u.test(search)) {
    return fail('fts', 'FTS schema or verification query is missing.');
  }
  return pass('fts', 'Static FTS contract is present; row-count verification is delegated to the local search gate.', {
    dataState: 'not-checked', expectedDocuments: null, projectedDocuments: null,
    missingDocuments: null, orphanedDocuments: null
  });
}

async function checkCleanup(root: string): Promise<PreflightCheck> {
  const schema = await readText(root, 'schema.sql');
  const maintenance = await readText(root, 'scripts/maintenance.ts');
  if (!/workspace_r2_cleanup_queue/u.test(schema) || !/cleanupQueueKeys/u.test(maintenance)) {
    return fail('cleanup', 'Cleanup queue schema or backlog query is missing.');
  }
  return skip('cleanup', 'Cleanup queue contract is present; no local D1 backlog was supplied.', {
    database: 'local-not-supplied', backlog: null
  });
}

async function checkOperationalState(root: string, category: 'claims' | 'attachments' | 'delivery') {
  const source = await readText(root, 'scripts/maintenance.ts');
  const patterns = category === 'claims'
    ? [/staleClaimCandidates/u]
    : category === 'attachments'
      ? [/expiredAttachmentKeys/u]
      : [/staleSubmittingCandidates/u, /expiredReviewCandidates/u];
  if (!patterns.every((pattern) => pattern.test(source))) return fail(category, 'Maintenance state query contract is missing.');
  return skip(category, 'Static maintenance contract is present; no local D1 state was supplied.', {
    database: 'local-not-supplied', candidates: null
  });
}

function parsedJson(output: string | undefined): unknown {
  if (!output) return null;
  const lines = output.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]!); } catch { /* Ignore Wrangler progress lines. */ }
  }
  return null;
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function dynamicSearchResult(result: CommandResult): PreflightCheck {
  const parsed = objectValue(parsedJson(result.stdout));
  if (result.exitCode !== 0) {
    const unavailable = /no such table|database .*not found|not initialized|cannot find.*d1|d1 .*unavailable/u.test(result.stderr ?? '');
    return unavailable
      ? skip('search', 'Search verification skipped because local D1 is unavailable.', { database: 'local-unavailable', expectedDocuments: null, projectedDocuments: null, missingDocuments: null, orphanedDocuments: null })
      : fail('search', 'Local search verification command failed.');
  }
  const expectedDocuments = numberValue(parsed.expectedDocuments);
  const projectedDocuments = numberValue(parsed.projectedDocuments);
  const missingDocuments = numberValue(parsed.missingDocuments);
  const orphanedDocuments = numberValue(parsed.orphanedDocuments);
  if ([expectedDocuments, projectedDocuments, missingDocuments, orphanedDocuments].some((value) => value === null)) {
    return fail('search', 'Local search verification did not return the stable JSON counters.');
  }
  return pass('search', 'Local search verification completed.', {
    target: typeof parsed.target === 'string' ? parsed.target : 'local',
    expectedDocuments, projectedDocuments, missingDocuments, orphanedDocuments
  });
}

function dynamicMaintenanceResults(result: CommandResult): PreflightCheck[] {
  if (result.exitCode !== 0) {
    const unavailable = /no such table|database .*not found|not initialized|cannot find.*d1|d1 .*unavailable/u.test(result.stderr ?? '');
    const status: PreflightStatus = unavailable ? 'SKIP' : 'FAIL';
    const summary = unavailable ? 'Maintenance state checks skipped because local D1 is unavailable.' : 'Local maintenance state command failed.';
    return [
      { category: 'cleanup', status, summary, details: { database: unavailable ? 'local-unavailable' : 'local', backlog: null, retryable: null, manualReview: null, staleJobs: null } },
      { category: 'claims', status, summary, details: { database: unavailable ? 'local-unavailable' : 'local', staleClaims: null } },
      { category: 'attachments', status, summary, details: { database: unavailable ? 'local-unavailable' : 'local', staleUploads: null } },
      { category: 'delivery', status, summary, details: { database: unavailable ? 'local-unavailable' : 'local', stuckSubmitting: null, expiredReview: null } }
    ];
  }
  const report = objectValue(parsedJson(result.stdout));
  if (Object.keys(report).length === 0) {
    const details = { database: 'local', candidates: null };
    return [
      fail('cleanup', 'Local maintenance did not return JSON state.'),
      fail('claims', 'Local maintenance did not return JSON state.'),
      fail('attachments', 'Local maintenance did not return JSON state.'),
      fail('delivery', 'Local maintenance did not return JSON state.')
    ].map((check) => ({ ...check, details }));
  }
  const r2 = objectValue(report.r2);
  const queue = objectValue(report.queue);
  const claims = objectValue(report.staleClaims);
  const delivery = objectValue(report.deliveryReview);
  return [
    pass('cleanup', 'Local cleanup queue state was reported.', {
      backlog: numberValue(queue.pending ?? r2.cleanupQueueRows), retryable: numberValue(queue.retryable),
      manualReview: numberValue(queue.manualReview ?? r2.manualReview ?? report.manualReview), staleJobs: numberValue(report.staleJobs)
    }),
    pass('claims', 'Local inbound claim state was reported.', { staleClaims: numberValue(claims.candidates) }),
    pass('attachments', 'Local attachment lifecycle state was reported.', { staleUploads: numberValue(r2.expiredAttachmentRows) }),
    pass('delivery', 'Local delivery lifecycle state was reported.', {
      stuckSubmitting: numberValue(delivery.staleSubmitting), expiredReview: numberValue(delivery.expiredReviewRequired)
    })
  ];
}

function dynamicCleanupReport(result: CommandResult): PreflightCheck {
  if (result.exitCode !== 0) {
    const unavailable = /no such table|database .*not found|not initialized|cannot find.*d1|d1 .*unavailable/u.test(result.stderr ?? '');
    return unavailable
      ? skip('cleanup', 'Cleanup queue state skipped because local D1 is unavailable.', {
        database: 'local-unavailable', backlog: null, retryable: null, manualReview: null, staleJobs: null
      })
      : fail('cleanup', 'Local cleanup queue report command failed.');
  }
  const report = objectValue(parsedJson(result.stdout));
  const queue = objectValue(report.queue);
  const pending = numberValue(queue.pending);
  const processing = numberValue(queue.processing);
  const retryable = numberValue(queue.retryable);
  const manualReview = numberValue(queue.manualReview);
  const staleJobs = numberValue(queue.staleProcessing);
  if ([pending, processing, retryable, manualReview, staleJobs].some((value) => value === null)) {
    return fail('cleanup', 'Local cleanup queue report did not return the stable JSON counters.');
  }
  return pass('cleanup', 'Local cleanup queue state was reported.', {
    database: 'local',
    backlog: pending! + processing! + retryable! + manualReview!,
    retryable,
    manualReview,
    staleJobs
  });
}

async function checkCommands(runCommands: boolean, commandRunner: CommandRunner): Promise<PreflightCheck[]> {
  const commands: Array<[PreflightCategory, string, string[]]> = [
    ['install', 'bun install --frozen-lockfile', ['--no-env-file', 'install', '--frozen-lockfile']],
    ['audit', 'bun run audit:dependencies', ['--no-env-file', 'run', 'audit:dependencies']],
    ['check', 'bun run check', ['--no-env-file', 'run', 'check']],
    ['typegen', 'bun run cf:typegen -- --check', ['--no-env-file', 'run', 'cf:typegen', '--', '--check']],
    ['build', 'bun run build', ['--no-env-file', 'run', 'build']]
  ];
  if (!runCommands) return [
    ...commands.map(([category, label]) => skip(category, `${label} not run by unit-test mode.`)),
    skip('search', 'bun run search:index -- --mode verify --json not run by unit-test mode.'),
    skip('cleanup', 'bun run maintenance -- --json not run by unit-test mode.'),
    skip('claims', 'bun run maintenance -- --json not run by unit-test mode.'),
    skip('attachments', 'bun run maintenance -- --json not run by unit-test mode.'),
    skip('delivery', 'bun run maintenance -- --json not run by unit-test mode.')
  ];
  const results: PreflightCheck[] = [];
  for (const [category, label, args] of commands) {
    const result = await commandRunner(process.execPath, args, { timeoutMs: 180_000 });
    if (result.exitCode === 0) results.push(pass(category, `${label} passed.`));
    else if (result.timedOut) results.push(fail(category, `${label} timed out.`));
    else results.push(fail(category, `${label} failed.`));
  }
  results.push(dynamicSearchResult(await commandRunner(process.execPath, [
    '--no-env-file', 'run', 'search:index', '--', '--mode', 'verify', '--json'
  ], { timeoutMs: 120_000 })));
  results.push(...dynamicMaintenanceResults(await commandRunner(process.execPath, [
    '--no-env-file', 'run', 'maintenance', '--', '--json'
  ], { timeoutMs: 120_000 })));
  results.push(dynamicCleanupReport(await commandRunner(process.execPath, [
    '--no-env-file', 'run', 'maintenance', '--', 'cleanup-report', '--json'
  ], { timeoutMs: 120_000 })));
  return results;
}

function mergeChecks(existing: PreflightCheck[], updates: PreflightCheck[]) {
  for (const update of updates) {
    const index = existing.findIndex((check) => check.category === update.category);
    if (index >= 0) existing[index] = update;
    else existing.push(update);
  }
}

export async function runPreflight(options: PreflightOptions = {}): Promise<PreflightReport> {
  const root = options.projectRoot ?? projectRoot;
  const runCommands = options.runCommands ?? true;
  const commandRunner = options.commandRunner ?? runCommand;
  const gitInspector = options.gitInspector ?? ((root: string) => inspectGit(root, commandRunner));
  const checks: PreflightCheck[] = [];
  try {
    const gitCheck = await checkGit(root, gitInspector);
    checks.push(gitCheck);
    checks.push(await checkBun(root));
    checks.push(await checkConfig(root));
    checks.push(await checkBindings(root));
    const schema = await checkSchema(root);
    checks.push(schema.schema, schema.health);
    checks.push(await checkFts(root));
    checks.push(await checkCleanup(root));
    checks.push(await checkStaticContract(root, 'checksum', 'Attachment checksum', [/workspace_attachments[\s\S]{0,400}sha256/u, /sha256Hex|crypto\.subtle\.digest/u]));
    checks.push(await checkOperationalState(root, 'claims'));
    checks.push(await checkOperationalState(root, 'attachments'));
    checks.push(await checkOperationalState(root, 'delivery'));
    checks.push(skip('search', 'Search verification contract is present; local D1 state is checked by the command gate.'));
    mergeChecks(checks, await checkCommands(runCommands && gitCheck.status === 'PASS', commandRunner));
  } catch (error) {
    checks.push(fail('config', 'Preflight could not inspect the checked-in project contract.', {
      reason: error instanceof Error ? error.message.slice(0, 160) : 'unknown error'
    }));
  }
  return {
    version: 1,
    target: 'local',
    readOnly: true,
    ok: checks.every((check) => check.status !== 'FAIL'),
    checks
  };
}

export function renderHuman(report: PreflightReport) {
  return [
    'FlareMail release preflight (local, read-only)',
    ...report.checks.map((check) => `${check.status} ${check.category}: ${check.summary}`),
    report.ok ? 'RESULT PASS' : 'RESULT FAIL'
  ].join('\n');
}

function parseArgs(args: string[]) {
  if (args.includes('--help')) {
    console.log('Usage: bun scripts/release-preflight.ts [--json]');
    process.exit(0);
  }
  const unknown = args.filter((arg) => arg !== '--json');
  if (unknown.length > 0) throw new Error(`Unknown option: ${unknown[0]}`);
  return { json: args.includes('--json') };
}

if (import.meta.main) {
  try {
    const { json } = parseArgs(process.argv.slice(2));
    const report = await runPreflight();
    console.log(json ? JSON.stringify(report) : renderHuman(report));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Release preflight failed.');
    process.exitCode = 1;
  }
}
