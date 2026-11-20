import { accessSync, constants, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CloudflareTarget } from './cloudflare-target.ts';
import { normalizePreInboundRecipient } from '../src/lib/server/inbound/pre-inbound.ts';
import { isMailHealthFresh, MAIL_HEALTH_REFRESH_WINDOW_MS, PREVIEW_CATCH_ALL_CRON_VERIFIED } from '../src/lib/domain/mail/health.ts';

export function sharedInboundPreviewTargetHash(target: CloudflareTarget) {
  return createHash('sha256').update(JSON.stringify(target)).digest('hex');
}

export function fixedReservationHash(value: string | undefined) {
  return value === undefined ? null : createHash('sha256').update(normalizePreInboundRecipient(value)).digest('hex');
}

function routingD1Id(value: unknown) {
  return typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(value) ? value.toLowerCase() : null;
}

function readRecentReceipt(receiptPath: string, errorCode: string) {
  const file = statSync(receiptPath);
  if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error(errorCode);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (!receipt || typeof receipt !== 'object') throw new Error(errorCode);
  const age = Date.now() - Date.parse(receipt.checkedAt);
  if (receipt.accountId !== process.env.CLOUDFLARE_ACCOUNT_ID || !/^[a-f0-9]{32}$/u.test(receipt.accountId) ||
      !(age >= 0 && age < 10 * 60_000)) throw new Error(errorCode);
  return receipt;
}

export function assertSharedInboundPreview(target: CloudflareTarget, receiptPath: string) {
  const receipt = readRecentReceipt(receiptPath, 'INBOUND_PREVIEW_PREFLIGHT_INVALID');
  const previewDb = routingD1Id(target.databaseId);
  const productionDb = routingD1Id(receipt.production?.databaseId);
  const registry = routingD1Id(target.inboundRouting?.databaseId);
  const delivery = receipt.production?.previewDelivery;
  const legacyFixedDelivery = delivery?.routingDatabaseId === null;
  const reserved = fixedReservationHash(target.vars.PRE_INBOUND_RECIPIENT);
  const managementEnabled = receipt.previewManagementAuthorized === true;
  if (receipt.previewName !== 'mail-ai' || receipt.workerName !== target.name ||
      !receipt.production?.deploymentId || !receipt.preview?.deploymentId ||
      !/^[a-f0-9]{40}$/u.test(receipt.previewCommit) || target.vars.APP_VERSION !== 'preview+' + receipt.previewCommit.slice(0, 7) ||
      receipt.targetHash !== sharedInboundPreviewTargetHash(target) ||
      !previewDb || !productionDb || !registry || new Set([previewDb, productionDb, registry]).size !== 3 ||
      routingD1Id(receipt.preview.databaseId) !== previewDb || routingD1Id(receipt.routingDatabaseId) !== registry ||
      receipt.preview.bucket !== target.bucket || !receipt.production.bucket || receipt.production.bucket === target.bucket ||
      (receipt.fixedReservationHash ?? null) !== reserved ||
      (delivery !== null && (routingD1Id(delivery?.databaseId) !== previewDb || delivery?.bucket !== target.bucket ||
        (legacyFixedDelivery ? !reserved : routingD1Id(delivery?.routingDatabaseId) !== registry) ||
        (delivery?.fixedReservationHash ?? null) !== reserved)) ||
      receipt.registryVerified !== true || receipt.previewBaseVerified !== true || target.cron.length !== 0 ||
      ['AUTO_REPLY_ENABLED', 'INBOUND_NOTIFICATION_ENABLED', 'TELEGRAM_ENABLED'].some(key => target.vars[key] !== 'false') ||
      Object.hasOwn(target.vars, 'CLOUDFLARE_EMAIL_ROUTING_TOKEN') ||
      (!managementEnabled && target.secrets?.includes('CLOUDFLARE_EMAIL_ROUTING_TOKEN')) ||
      (managementEnabled && (delivery === null || legacyFixedDelivery || target.vars.MAIL_IDENTITY_WORKER_NAME !== target.name ||
        target.vars.MAIL_IDENTITY_ACCOUNT_ID !== receipt.accountId))) {
    throw new Error('INBOUND_PREVIEW_PREFLIGHT_INVALID');
  }
  return {
    previewCommit: receipt.previewCommit as string, deploymentId: receipt.production.deploymentId as string,
    productionDb, productionBucket: receipt.production.bucket as string, expectsDelivery: delivery !== null, legacyFixedDelivery, managementEnabled,
    previewDeploymentId: receipt.preview.deploymentId as string
  };
}

export function assertSharedInboundProduction(target: CloudflareTarget, receiptPath: string) {
  const errorCode = 'INBOUND_PRODUCTION_PREFLIGHT_INVALID';
  const receipt = readRecentReceipt(receiptPath, errorCode);
  const productionDb = routingD1Id(target.databaseId);
  const previewDb = routingD1Id(target.preInbound?.databaseId);
  const registry = routingD1Id(target.inboundRouting?.databaseId);
  const phase = receipt.phase;
  const pauseOnly = phase === 'pause';
  const reserved = fixedReservationHash(target.vars.PRE_INBOUND_RECIPIENT);
  if (!['protect', 'activate', 'maintain', 'pause'].includes(phase) || (target.vars.PRE_INBOUND_ENABLED === 'false') !== (phase === 'protect' || pauseOnly) ||
      receipt.workerName !== target.name || receipt.previewName !== 'mail-ai' ||
      receipt.targetHash !== sharedInboundPreviewTargetHash(target) ||
      !/^[a-f0-9]{40}$/u.test(receipt.releaseCommit) ||
      target.vars.APP_VERSION !== 'production+' + receipt.releaseCommit.slice(0, 7) ||
      (!pauseOnly && (!/^[a-f0-9]{40}$/u.test(receipt.acceptedPreviewCommit) ||
        receipt.preview?.buildLabel !== 'preview+' + receipt.acceptedPreviewCommit.slice(0, 7) || receipt.ownerAcceptanceVerified !== true ||
        !receipt.preview?.deploymentId || routingD1Id(receipt.preview.databaseId) !== previewDb || receipt.preview.bucket !== target.preInbound?.bucket ||
        (receipt.preview.fixedReservationHash ?? null) !== reserved)) || !receipt.production?.deploymentId ||
      !productionDb || !previewDb || !registry || new Set([productionDb, previewDb, registry]).size !== 3 ||
      routingD1Id(receipt.production.databaseId) !== productionDb ||
      routingD1Id(receipt.routingDatabaseId) !== registry || receipt.production.bucket !== target.bucket ||
      target.preInbound?.bucket === target.bucket ||
      (receipt.production.fixedReservationHash && receipt.production.fixedReservationHash !== reserved) ||
      (phase === 'protect' && (receipt.production.fixedReservationHash !== reserved ||
        (!reserved && receipt.legacyFixedRecipientAbsent !== true))) ||
      receipt.registryVerified !== true || receipt.versionUrlsDisabled !== true || (!pauseOnly && !target.cron.length) ||
      (!pauseOnly && phase !== 'maintain' && receipt.legacyOperationsQuiesced !== true) ||
      (phase === 'activate' && (!routingD1Id(receipt.protectVersionId) || receipt.protectionActive !== true ||
        receipt.mailRoutesAndMappingsVerified !== true || receipt.preCatchAllsVerified !== true))) {
    throw new Error(errorCode);
  }
  return {
    releaseCommit: receipt.releaseCommit as string, acceptedPreviewCommit: receipt.acceptedPreviewCommit as string,
    deploymentId: receipt.production.deploymentId as string, protectVersionId: phase === 'activate' ? receipt.protectVersionId as string : null,
    protecting: phase === 'protect', maintaining: phase === 'maintain', pauseOnly,
    previewDeploymentId: (receipt.preview?.deploymentId ?? '') as string, previewBuildLabel: (receipt.preview?.buildLabel ?? '') as string
  };
}

function git(projectRoot: string, args: string[]) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function assertReleaseCheckout(projectRoot: string, commit: string, code: string) {
  if (git(projectRoot, ['rev-parse', 'HEAD']) !== commit || git(projectRoot, ['status', '--porcelain'])) {
    throw new Error(code);
  }
}

export function assertProductionReleaseSource(projectRoot: string, source: { releaseCommit: string; acceptedPreviewCommit: string }) {
  assertReleaseCheckout(projectRoot, source.releaseCommit, 'INBOUND_PRODUCTION_RELEASE_SOURCE_NOT_VERIFIED');
  try {
    if (git(projectRoot, ['rev-parse', source.releaseCommit + '^{tree}']) === git(projectRoot, ['rev-parse', source.acceptedPreviewCommit + '^{tree}'])) return;
  } catch {
    // A missing accepted source revision is also insufficient release evidence.
  }
  throw new Error('INBOUND_PRODUCTION_RELEASE_DIFFERS_FROM_PRE_ACCEPTANCE');
}

interface WorkerBindingMetadata {
  name: string;
  type?: string;
  database_id?: string;
  id?: string;
  bucket_name?: string;
  text?: string;
  json?: { recipient?: string | null; enabled?: boolean; readOnly?: boolean; environment?: string; previewCatchAllCapacity?: number } | string;
}

function readActiveProduction(worker: string) {
  if (!/^[a-f0-9]{32}$/u.test(process.env.CLOUDFLARE_ACCOUNT_ID ?? '')) {
    throw new Error('INBOUND_PRODUCTION_ACCOUNT_NOT_VERIFIED');
  }
  // Avoid evaluating the project's Cloudflare configuration during metadata reads.
  const directory = mkdtempSync(join(tmpdir(), 'flaremail-active-worker-'));
  const cf = (args: string[]) => JSON.parse(execFileSync('cf', args, {
    cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 12_000
  }));
  try {
    let deployments;
    try {
      deployments = cf(['workers', 'deployments', 'list', '--worker', worker, '--per-page', '1']).deployments;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? '';
      if (/\[10007\].*worker does not exist/iu.test(stderr) && /\b404 Not Found\b/u.test(stderr)) return null;
      throw new Error('INBOUND_PRODUCTION_ACTIVE_BINDINGS_UNAVAILABLE');
    }
    if (!Array.isArray(deployments)) throw new Error('INBOUND_PRODUCTION_ACTIVE_BINDINGS_UNAVAILABLE');
    if (!deployments.length) return null;
    const versions = deployments[0].versions;
    const activeVersions = Array.isArray(versions) ? versions.filter(item => item.percentage > 0) : [];
    if (!activeVersions.length || activeVersions.some(item => !routingD1Id(item.version_id))) {
      throw new Error('INBOUND_PRODUCTION_ACTIVE_BINDINGS_UNAVAILABLE');
    }
    const metadata = activeVersions.map(version => {
      let details;
      try {
        details = cf(['workers', 'versions', 'get', version.version_id, '--worker', worker]);
      } catch {
        throw new Error('INBOUND_PRODUCTION_ACTIVE_BINDINGS_UNAVAILABLE');
      }
      const bindings = details.bindings ?? details.resources?.bindings;
      const runtime = details.resources?.script_runtime ?? details;
      if (!Array.isArray(bindings)) throw new Error('INBOUND_PRODUCTION_ACTIVE_BINDINGS_UNAVAILABLE');
      return {
        id: String(version.version_id), percentage: Number(version.percentage), bindings: bindings as WorkerBindingMetadata[],
        deployedAt: Date.parse(deployments[0].created_on ?? ''),
        compatibilityDate: runtime.compatibility_date as string | undefined,
        compatibilityFlags: (runtime.compatibility_flags ?? []) as string[]
      };
    });
    return { deploymentId: String(deployments[0].id), versions: metadata };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function assertLegacyProductionHasNoActiveInboundProtection(worker: string) {
  if (readActiveProduction(worker)?.versions.some(version => version.bindings.some(binding =>
    ['INBOUND_ROUTING_DB', 'INBOUND_ROUTING_SCOPE', 'PRE_INBOUND_SETTINGS'].includes(binding.name)))) {
    throw new Error('INBOUND_PRODUCTION_ACTIVE_PROTECTION_REQUIRED');
  }
}

function requireActiveProductionVersion(workerName: string, deploymentId: string) {
  const active = readActiveProduction(workerName);
  const version = active?.versions?.[0];
  if (!version || active?.deploymentId !== deploymentId || active.versions.length !== 1 || version.percentage !== 100) {
    throw new Error('INBOUND_PRODUCTION_DEPLOYMENT_CHANGED');
  }
  const binding = (name: string) => version.bindings.find(entry => entry.name === name);
  const db = (name: string) => routingD1Id(binding(name)?.database_id ?? binding(name)?.id);
  const bucket = (name: string) => binding(name)?.bucket_name;
  const value = binding('PRE_INBOUND_SETTINGS')?.json;
  const settings = typeof value === 'string' ? JSON.parse(value) as Exclude<WorkerBindingMetadata['json'], string> : value;
  return { version, binding, db, bucket, settings };
}

function cloudflareReleaseIdentity(projectRoot: string) {
  return JSON.parse(execFileSync('cf', ['auth', 'whoami', '--json'], {
    cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 12_000
  })) as { authenticated?: boolean; accounts?: { id?: string }[]; profile?: { name?: string } };
}

export function pinCloudflareReleaseIdentity(projectRoot: string, discoverAccount: boolean) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AUTH_PROFILE) return;
  const auth = cloudflareReleaseIdentity(projectRoot);
  if (!auth.authenticated) throw new Error('INBOUND_PRODUCTION_ACCOUNT_NOT_VERIFIED');
  const profile = auth.profile?.name;
  if (!process.env.CLOUDFLARE_AUTH_PROFILE && profile && /^[\w-]+$/u.test(profile)) process.env.CLOUDFLARE_AUTH_PROFILE = profile;
  if (discoverAccount && !process.env.CLOUDFLARE_ACCOUNT_ID) {
    let selected: string | undefined;
    try {
      selected = execFileSync('node', ['--input-type=module', '-e',
        "import { pathToFileURL } from 'node:url'; const { a: account } = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(await account() || '');",
        cloudflareCliModule('context-BiFPu-hE.mjs')], {
        cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 12_000
      }).trim();
    } catch {
      // Fall back only when cf reports a single accessible account.
    }
    const account = selected || (auth.accounts?.length === 1 ? auth.accounts[0]?.id : undefined);
    if (!account || !/^[a-f0-9]{32}$/u.test(account)) throw new Error('INBOUND_PRODUCTION_ACCOUNT_NOT_VERIFIED');
    process.env.CLOUDFLARE_ACCOUNT_ID = account;
  }
}

function cloudflareCliModule(name: string) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const cli = join(dir, 'cf');
    try {
      accessSync(cli, constants.X_OK);
      if (!statSync(cli).isFile()) continue;
    } catch {
      continue;
    }
    try {
      const root = dirname(dirname(realpathSync(cli)));
      const { name: packageName, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      if (packageName === 'cf' && version === '1.0.0-rc.1') {
        // shortcut: use the pinned CLI's modules until account selection and generic reads have public commands.
        return join(root, 'dist', name);
      }
    } catch {
      // An unrecognized executable cannot provide the pinned metadata transport.
    }
    break;
  }
  throw new Error('INBOUND_PRODUCTION_PREVIEW_METADATA_AUTH_UNAVAILABLE');
}

function cloudflareWorkerMetadata(projectRoot: string, errorCode: string) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account || !/^[a-f0-9]{32}$/u.test(account)) throw new Error('INBOUND_PRODUCTION_ACCOUNT_NOT_VERIFIED');
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() || process.env.CF_API_TOKEN?.trim();
  if (!token) pinCloudflareReleaseIdentity(projectRoot, false);
  const rawFetch = token ? undefined : cloudflareCliModule('raw-fetch-g83RSAGp.mjs');
  return async <T>(path: string) => {
    const resource = '/accounts/' + account + '/workers/' + path;
    try {
      let output: string;
      if (rawFetch) {
        output = execFileSync('node', ['--input-type=module', '-e',
          "import { pathToFileURL } from 'node:url'; const { t: get } = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(await get(process.argv[2]));",
          rawFetch, resource], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 12_000 });
      } else {
        const response = await fetch('https://api.cloudflare.com/client/v4' + resource, {
          headers: { Authorization: 'Bearer ' + token },
          signal: AbortSignal.timeout(8_000), redirect: 'error'
        });
        if (!response.ok) throw new Error(errorCode);
        output = await response.text();
      }
      const envelope = JSON.parse(output) as { success: boolean; result: T };
      if (envelope.success === true) return envelope.result;
    } catch {
      // The transport can include sensitive provider metadata in errors.
    }
    throw new Error(errorCode);
  };
}


async function readLiveNativePreview(workerName: string, projectRoot: string) {
  const get = cloudflareWorkerMetadata(projectRoot, 'INBOUND_PRODUCTION_PREVIEW_METADATA_UNAVAILABLE');
  const workers = 'workers/';
  const worker = await get<{ id?: string; previews_base_config?: { env?: Record<string, unknown> } }>(
    workers + encodeURIComponent(workerName)
  );
  if (!worker?.id) throw new Error('INBOUND_PRODUCTION_PREVIEW_DEPLOYMENT_CHANGED');
  const path = workers + encodeURIComponent(worker.id) + '/previews';
  const previews = await get<Array<{ id?: string; slug?: string }>>(path + '?slug=mail-ai');
  const preview = Array.isArray(previews) ? previews.find(entry => entry.slug === 'mail-ai') : null;
  if (!preview?.id) throw new Error('INBOUND_PRODUCTION_PREVIEW_DEPLOYMENT_CHANGED');
  const latest = await get<{ id?: string; env?: Record<string, { text?: string; database_id?: string; id?: string; bucket_name?: string; json?: WorkerBindingMetadata['json'] }> }>(
    path + '/' + encodeURIComponent(preview.id) + '/deployments/latest?include=bindings'
  );
  return { latest, baseEnv: worker.previews_base_config?.env };
}

export async function assertLiveNativePreview(
  target: CloudflareTarget, source: { previewDeploymentId: string; previewBuildLabel: string }, projectRoot: string
) {
  const { latest } = await readLiveNativePreview(target.name, projectRoot);
  const env = latest?.env;
  const binding = env?.PRE_INBOUND_SETTINGS;
  const value = binding?.json;
  let reservationMatches = false;
  try {
    const settings = typeof value === 'string' ? JSON.parse(value) as Exclude<WorkerBindingMetadata['json'], string> : value;
    if (!binding || (settings && (settings.recipient === null || typeof settings.recipient === 'string'))) {
      reservationMatches = fixedReservationHash(settings?.recipient ?? undefined) === fixedReservationHash(target.vars.PRE_INBOUND_RECIPIENT);
    }
  } catch {
    // Treat invalid reservation metadata as a deployment mismatch.
  }
  if (latest?.id !== source.previewDeploymentId || env?.APP_ENV?.text !== 'preview' || env?.APP_VERSION?.text !== source.previewBuildLabel ||
      !reservationMatches ||
      routingD1Id(env?.DB?.database_id ?? env?.DB?.id) !== routingD1Id(target.preInbound?.databaseId) ||
      env?.BUCKET?.bucket_name !== target.preInbound?.bucket ||
      routingD1Id(env?.INBOUND_ROUTING_DB?.database_id ?? env?.INBOUND_ROUTING_DB?.id) !== routingD1Id(target.inboundRouting?.databaseId)) {
    throw new Error('INBOUND_PRODUCTION_PREVIEW_DEPLOYMENT_CHANGED');
  }
  try {
    const raw = env.INBOUND_ROUTING_SCOPE?.json;
    const scope = typeof raw === 'string' ? JSON.parse(raw) as Exclude<WorkerBindingMetadata['json'], string> : raw;
    if (scope?.environment === 'preview') {
      if (scope.readOnly === true) return 0;
      const capacity = scope.previewCatchAllCapacity;
      if (typeof capacity === 'number' && Number.isSafeInteger(capacity) && capacity > 0) return capacity;
    }
  } catch {
    // Invalid binding JSON cannot authorize writable PRE.
  }
  throw new Error('INBOUND_PRODUCTION_PREVIEW_DEPLOYMENT_CHANGED');
}

export async function assertLivePreviewForPublish(
  target: CloudflareTarget, source: { previewDeploymentId: string; managementEnabled: boolean }, projectRoot: string
) {
  const { latest, baseEnv } = await readLiveNativePreview(target.name, projectRoot);
  const env = latest?.env;
  const registry = routingD1Id(env?.INBOUND_ROUTING_DB?.database_id ?? env?.INBOUND_ROUTING_DB?.id);
  if (latest?.id !== source.previewDeploymentId || env?.APP_ENV?.text !== 'preview' ||
      routingD1Id(env?.DB?.database_id ?? env?.DB?.id) !== routingD1Id(target.databaseId) || env?.BUCKET?.bucket_name !== target.bucket ||
      (env?.INBOUND_ROUTING_DB && registry !== routingD1Id(target.inboundRouting?.databaseId)) ||
      (!source.managementEnabled && (env?.CLOUDFLARE_EMAIL_ROUTING_TOKEN || baseEnv?.CLOUDFLARE_EMAIL_ROUTING_TOKEN))) {
    throw new Error('INBOUND_PREVIEW_DEPLOYMENT_CHANGED');
  }
  if (source.managementEnabled) {
    const errorCode = 'INBOUND_PREVIEW_PRODUCTION_OBSERVER_NOT_CONFIGURED';
    const get = cloudflareWorkerMetadata(projectRoot, errorCode);
    const { schedules } = await get<{ schedules?: { cron: string }[] }>('scripts/' + encodeURIComponent(target.name) + '/schedules');
    if (!Array.isArray(schedules) || !schedules.every(schedule => typeof schedule?.cron === 'string')) throw new Error(errorCode);
    const capacity = catchAllRefreshCapacity(schedules.map(schedule => schedule.cron));
    if (!capacity) throw new Error(errorCode);
    const [claims] = await readReleaseD1Rows<{ count: number }>(
      target.inboundRouting?.databaseId,
      "SELECT count(*) AS count FROM inbound_routing_ownership WHERE kind = 'catch_all' AND environment = 'preview'",
      errorCode
    );
    if (!claims || !Number.isSafeInteger(claims.count) || claims.count > capacity) throw new Error(errorCode);
    return capacity;
  }
  return 0;
}

export function assertActiveProductionForPreview(target: CloudflareTarget, source: ReturnType<typeof assertSharedInboundPreview>) {
  const { version, binding, db, bucket, settings } = requireActiveProductionVersion(target.name, source.deploymentId);
  if (db('DB') !== source.productionDb || bucket('BUCKET') !== source.productionBucket) {
    throw new Error('INBOUND_PREVIEW_PREFLIGHT_INVALID');
  }
  if (source.expectsDelivery) {
    const registryMatches = source.legacyFixedDelivery
      ? !binding('INBOUND_ROUTING_DB') && !binding('INBOUND_ROUTING_SCOPE')
      : db('INBOUND_ROUTING_DB') === routingD1Id(target.inboundRouting?.databaseId);
    if (!settings || !registryMatches ||
        db('PRE_INBOUND_DB') !== routingD1Id(target.databaseId) || bucket('PRE_INBOUND_BUCKET') !== target.bucket ||
        fixedReservationHash(settings.recipient ?? undefined) !== fixedReservationHash(target.vars.PRE_INBOUND_RECIPIENT)) {
      throw new Error('INBOUND_PREVIEW_PREFLIGHT_INVALID');
    }
  } else if (['INBOUND_ROUTING_DB', 'INBOUND_ROUTING_SCOPE', 'PRE_INBOUND_SETTINGS', 'PRE_INBOUND_DB', 'PRE_INBOUND_BUCKET'].some(name => binding(name))) {
    throw new Error('INBOUND_PREVIEW_PREFLIGHT_INVALID');
  }
  if (source.managementEnabled) {
    if (settings?.enabled !== true) throw new Error('INBOUND_PREVIEW_MANAGEMENT_REQUIRES_ACTIVE_DELIVERY');
    if (currentCatchAllCredential(version.bindings)?.type !== 'secret_text') {
      throw new Error('INBOUND_PREVIEW_PRODUCTION_OBSERVER_NOT_CONFIGURED');
    }
  }
}

function sameStrings(left: string[], right: string[]) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function assertUnchangedProductionConfiguration(
  target: CloudflareTarget,
  active: { bindings: WorkerBindingMetadata[]; compatibilityDate?: string; compatibilityFlags: string[]; cron: string[] }
) {
  const { PRE_INBOUND_ENABLED: _enabled, PRE_INBOUND_RECIPIENT: _recipient, ...vars } = target.vars;
  const activeVars = active.bindings.filter(binding => binding.type === 'plain_text');
  const activeSecrets = active.bindings.filter(binding => binding.type === 'secret_text').map(binding => binding.name);
  if (Object.keys(vars).length !== activeVars.length ||
      activeVars.some(binding => !Object.hasOwn(vars, binding.name) || vars[binding.name] !== binding.text) ||
      !sameStrings(target.secrets ?? [], activeSecrets) ||
      target.compatibilityDate !== active.compatibilityDate ||
      !sameStrings(target.compatibilityFlags, active.compatibilityFlags) || !sameStrings(target.cron, active.cron)) {
    throw new Error('INBOUND_PRODUCTION_CUTOVER_CONFIGURATION_CHANGED');
  }
}

interface ObservabilityMetadata {
  enabled?: boolean;
  head_sampling_rate?: number;
  persist?: boolean;
  invocation_logs?: boolean;
  destinations?: string[];
}

export async function verifyProductionWorkerDev(target: CloudflareTarget, projectRoot: string) {
  const errorCode = 'INBOUND_PRODUCTION_VERSION_URLS_NOT_DISABLED';
  const get = cloudflareWorkerMetadata(projectRoot, errorCode);
  const subdomain = await get<{ enabled?: boolean; previews_enabled?: boolean }>(
    'scripts/' + encodeURIComponent(target.name) + '/subdomain'
  );
  if (subdomain?.previews_enabled !== false || typeof subdomain.enabled !== 'boolean') throw new Error(errorCode);
  return subdomain.enabled;
}

const catchAllCredentialNames = ['CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN', 'CLOUDFLARE_EMAIL_ROUTING_TOKEN'];

function currentCatchAllCredential(bindings: WorkerBindingMetadata[]) {
  const name = catchAllCredentialNames.find(key => bindings.some(binding => binding.name === key));
  return bindings.find(binding => binding.name === name);
}

function catchAllRefreshCapacity(schedules: string[]) {
  return Math.max(0, ...schedules.map(schedule => {
    const minute = /^(\*|\*\/[1-5]?\d|[1-5]?\d)(?:\s+\*){4}$/u.exec(schedule.trim())?.[1];
    if (!minute) return 0;
    const minutesPerRun = minute === '*' ? 1 : minute.startsWith('*/') ? Number(minute.slice(2)) : 60;
    return minutesPerRun > 0 ? Math.floor((MAIL_HEALTH_REFRESH_WINDOW_MS - 1) / (minutesPerRun * 60_000)) : 0;
  }));
}

async function readReleaseD1Rows<T>(databaseId: string | undefined, sql: string, errorCode: string) {
  const { normalizeD1Output } = await import('./cloudflare-target.ts');
  const id = routingD1Id(databaseId);
  if (!id) throw new Error(errorCode);
  const directory = mkdtempSync(join(tmpdir(), 'flaremail-cutover-d1-'));
  try {
    const output = execFileSync('cf', ['d1', 'raw', id, '--sql', sql], {
      cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 12_000
    });
    const result = normalizeD1Output(JSON.parse(output)) as { success?: boolean; results?: T[] }[];
    const statement = result[0];
    if (statement?.success !== true || !Array.isArray(statement.results)) throw new Error(errorCode);
    return statement.results;
  } catch {
    throw new Error(errorCode);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function assertProductionCatchAllRelease(
  target: CloudflareTarget, version: ReturnType<typeof assertActiveProductionForRelease>, projectRoot: string,
  requireCurrentObservations = true, previewCatchAllCapacity = 0
) {
  const errorCode = 'INBOUND_PRODUCTION_PREVIEW_CATCH_ALL_REFRESH_NOT_VERIFIED';
  const claims = await readReleaseD1Rows<{ route_key: string }>(target.inboundRouting?.databaseId,
    `SELECT route_key FROM inbound_routing_ownership WHERE kind = 'catch_all' AND environment = 'preview'`,
    'INBOUND_PRODUCTION_ROUTING_REGISTRY_NOT_READY');
  const domains = await readReleaseD1Rows<{ domain_name: string; worker_name: string; catch_all_target: string; catch_all_checked_at: string | null; last_error_code: string | null; last_error_at: string | null }>(
    target.preInbound?.databaseId,
    `SELECT lower(domain_name) AS domain_name, worker_name, catch_all_target, catch_all_checked_at, last_error_code, last_error_at
     FROM mail_domains WHERE enabled = 1 AND unknown_recipient_policy = 'collect'`,
    errorCode
  );
  const requiredCapacity = Math.max(domains.length, previewCatchAllCapacity);
  if (requiredCapacity) {
    if (catchAllRefreshCapacity(target.cron) < requiredCapacity) {
      throw new Error('INBOUND_PRODUCTION_PREVIEW_CATCH_ALL_CRON_CAPACITY');
    }
    const current = currentCatchAllCredential(version.bindings);
    const candidate = catchAllCredentialNames.find(key => target.secrets?.includes(key));
    if (current?.type !== 'secret_text' || candidate !== current.name ||
        catchAllCredentialNames.some(key => Object.hasOwn(target.vars, key))) {
      throw new Error('INBOUND_PRODUCTION_PREVIEW_CATCH_ALL_CREDENTIAL_CHANGED');
    }
  }
  if (!requireCurrentObservations) return;
  const get = cloudflareWorkerMetadata(projectRoot, errorCode);
  const scheduleResult = await get<{ schedules?: { cron: string }[] }>('scripts/' + encodeURIComponent(target.name) + '/schedules');
  if (!Array.isArray(scheduleResult.schedules) || !scheduleResult.schedules.length ||
      scheduleResult.schedules.some(schedule => typeof schedule.cron !== 'string') || !Number.isFinite(version.deployedAt)) {
    throw new Error(errorCode);
  }
  assertUnchangedProductionConfiguration(target, { ...version, cron: scheduleResult.schedules.map(schedule => schedule.cron) });
  const owned = new Set(claims.map(claim => claim.route_key));
  const now = Date.now();
  if (domains.some(domain => !owned.has(domain.domain_name) || domain.worker_name !== target.name ||
      domain.catch_all_target !== 'this_worker' || domain.last_error_code !== PREVIEW_CATCH_ALL_CRON_VERIFIED ||
      domain.last_error_at !== domain.catch_all_checked_at || !isMailHealthFresh(domain.catch_all_checked_at, now) ||
      (version.routingReadOnly && Date.parse(domain.catch_all_checked_at ?? '') < version.deployedAt))) throw new Error(errorCode);
}

export async function readPauseObservability(
  target: CloudflareTarget, version: ReturnType<typeof assertActiveProductionForRelease>, projectRoot: string
) {
  const get = cloudflareWorkerMetadata(projectRoot, 'INBOUND_PRODUCTION_PAUSE_CONFIGURATION_UNAVAILABLE');
  const path = 'scripts/' + encodeURIComponent(target.name);
  const [{ schedules }, { observability }] = await Promise.all([
    get<{ schedules?: { cron: string }[] }>(path + '/schedules'),
    get<{ observability?: ObservabilityMetadata & {
      redact_query_string?: boolean;
      issues?: { enabled?: boolean };
      logs?: ObservabilityMetadata;
      traces?: ObservabilityMetadata;
    } }>(path + '/script-settings')
  ]);
  if (!Array.isArray(schedules) || schedules.some(schedule => typeof schedule.cron !== 'string')) {
    throw new Error('INBOUND_PRODUCTION_PAUSE_CONFIGURATION_UNAVAILABLE');
  }
  assertUnchangedProductionConfiguration(target, { ...version, cron: schedules.map(schedule => schedule.cron) });
  const sink = (value: ObservabilityMetadata) => ({
    enabled: value.enabled, headSamplingRate: value.head_sampling_rate,
    persist: value.persist, destinations: value.destinations
  });
  return observability ? {
    enabled: observability.enabled ?? false, headSamplingRate: observability.head_sampling_rate,
    redactQueryString: observability.redact_query_string, issues: observability.issues ?? undefined,
    logs: observability.logs ? { ...sink(observability.logs), invocationLogs: observability.logs.invocation_logs } : undefined,
    traces: observability.traces ? sink(observability.traces) : undefined
  } : { enabled: false };
}

export function assertActiveProductionForRelease(target: CloudflareTarget, source: ReturnType<typeof assertSharedInboundProduction>) {
  const { version, binding, db, bucket, settings } = requireActiveProductionVersion(target.name, source.deploymentId);
  if (db('DB') !== routingD1Id(target.databaseId) || bucket('BUCKET') !== target.bucket) {
    throw new Error('INBOUND_PRODUCTION_DEPLOYMENT_CHANGED');
  }
  const existingRegistry = db('INBOUND_ROUTING_DB');
  const legacyFixedUpgrade = source.protecting && Boolean(settings?.recipient) &&
    !binding('INBOUND_ROUTING_DB') && !binding('INBOUND_ROUTING_SCOPE');
  if (source.protectVersionId || source.maintaining || source.pauseOnly ||
      ['INBOUND_ROUTING_DB', 'INBOUND_ROUTING_SCOPE', 'PRE_INBOUND_SETTINGS'].some(name => binding(name))) {
    if (!settings || (!legacyFixedUpgrade && existingRegistry !== routingD1Id(target.inboundRouting?.databaseId)) ||
        db('PRE_INBOUND_DB') !== routingD1Id(target.preInbound?.databaseId) || bucket('PRE_INBOUND_BUCKET') !== target.preInbound?.bucket ||
        fixedReservationHash(settings.recipient ?? undefined) !== fixedReservationHash(target.vars.PRE_INBOUND_RECIPIENT) ||
        (source.protectVersionId && (version.id !== source.protectVersionId || settings.enabled !== false)) ||
        (source.maintaining && settings.enabled !== true) ||
        (source.pauseOnly && (settings.enabled !== true || binding('APP_VERSION')?.text !== target.vars.APP_VERSION))) {
      throw new Error('INBOUND_PRODUCTION_ACTIVE_PROTECTION_REQUIRED');
    }
  }
  const scopeBinding = binding('INBOUND_ROUTING_SCOPE')?.json;
  const scope = typeof scopeBinding === 'string' ? JSON.parse(scopeBinding) as Exclude<WorkerBindingMetadata['json'], string> : scopeBinding;
  return { ...version, routingReadOnly: scope?.readOnly === true };
}
