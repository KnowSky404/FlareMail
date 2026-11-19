import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { CloudflareTarget } from './cloudflare-target.ts';
import { normalizePreInboundRecipient } from '../src/lib/server/inbound/pre-inbound.ts';

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
        routingD1Id(delivery?.routingDatabaseId) !== registry || (delivery?.fixedReservationHash ?? null) !== reserved)) ||
      receipt.registryVerified !== true || receipt.previewBaseVerified !== true || target.cron.length !== 0 ||
      ['AUTO_REPLY_ENABLED', 'INBOUND_NOTIFICATION_ENABLED', 'TELEGRAM_ENABLED'].some(key => target.vars[key] !== 'false') ||
      Object.hasOwn(target.vars, 'CLOUDFLARE_EMAIL_ROUTING_TOKEN') ||
      (!managementEnabled && target.secrets?.includes('CLOUDFLARE_EMAIL_ROUTING_TOKEN')) ||
      (managementEnabled && (delivery === null || target.vars.MAIL_IDENTITY_WORKER_NAME !== target.name ||
        target.vars.MAIL_IDENTITY_ACCOUNT_ID !== receipt.accountId))) {
    throw new Error('INBOUND_PREVIEW_PREFLIGHT_INVALID');
  }
  return {
    previewCommit: receipt.previewCommit as string, deploymentId: receipt.production.deploymentId as string,
    productionDb, productionBucket: receipt.production.bucket as string, expectsDelivery: delivery !== null, managementEnabled
  };
}

export function assertSharedInboundProduction(target: CloudflareTarget, receiptPath: string) {
  const errorCode = 'INBOUND_PRODUCTION_PREFLIGHT_INVALID';
  const receipt = readRecentReceipt(receiptPath, errorCode);
  const productionDb = routingD1Id(target.databaseId);
  const previewDb = routingD1Id(target.preInbound?.databaseId);
  const registry = routingD1Id(target.inboundRouting?.databaseId);
  const phase = receipt.phase;
  const reserved = fixedReservationHash(target.vars.PRE_INBOUND_RECIPIENT);
  if (!['protect', 'activate', 'maintain'].includes(phase) || (target.vars.PRE_INBOUND_ENABLED === 'false') !== (phase === 'protect') ||
      receipt.workerName !== target.name || receipt.previewName !== 'mail-ai' ||
      receipt.targetHash !== sharedInboundPreviewTargetHash(target) ||
      !/^[a-f0-9]{40}$/u.test(receipt.releaseCommit) ||
      target.vars.APP_VERSION !== 'production+' + receipt.releaseCommit.slice(0, 7) ||
      !/^[a-f0-9]{40}$/u.test(receipt.acceptedPreviewCommit) ||
      receipt.preview?.buildLabel !== 'preview+' + receipt.acceptedPreviewCommit.slice(0, 7) || receipt.ownerAcceptanceVerified !== true ||
      !receipt.production?.deploymentId || !receipt.preview?.deploymentId ||
      !productionDb || !previewDb || !registry || new Set([productionDb, previewDb, registry]).size !== 3 ||
      routingD1Id(receipt.production.databaseId) !== productionDb || routingD1Id(receipt.preview.databaseId) !== previewDb ||
      routingD1Id(receipt.routingDatabaseId) !== registry || receipt.production.bucket !== target.bucket ||
      receipt.preview.bucket !== target.preInbound?.bucket || receipt.preview.bucket === target.bucket ||
      (receipt.preview.fixedReservationHash ?? null) !== reserved ||
      (receipt.production.fixedReservationHash && receipt.production.fixedReservationHash !== reserved) ||
      receipt.registryVerified !== true || receipt.versionUrlsDisabled !== true || (phase !== 'maintain' && receipt.legacyOperationsQuiesced !== true) ||
      (phase === 'activate' && (!routingD1Id(receipt.protectVersionId) || receipt.protectionActive !== true ||
        receipt.mailRoutesAndMappingsVerified !== true || receipt.preCatchAllsVerified !== true))) {
    throw new Error(errorCode);
  }
  return {
    releaseCommit: receipt.releaseCommit as string, acceptedPreviewCommit: receipt.acceptedPreviewCommit as string,
    deploymentId: receipt.production.deploymentId as string, protectVersionId: phase === 'activate' ? receipt.protectVersionId as string : null,
    maintaining: phase === 'maintain', previewDeploymentId: receipt.preview.deploymentId as string, previewBuildLabel: receipt.preview.buildLabel as string
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
  database_id?: string;
  id?: string;
  bucket_name?: string;
  json?: { recipient?: string | null; enabled?: boolean } | string;
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
      let bindings;
      try {
        const metadata = cf(['workers', 'versions', 'get', version.version_id, '--worker', worker]);
        bindings = metadata.bindings ?? metadata.resources?.bindings;
      } catch {
        throw new Error('INBOUND_PRODUCTION_ACTIVE_BINDINGS_UNAVAILABLE');
      }
      if (!Array.isArray(bindings)) throw new Error('INBOUND_PRODUCTION_ACTIVE_BINDINGS_UNAVAILABLE');
      return { id: String(version.version_id), percentage: Number(version.percentage), bindings: bindings as WorkerBindingMetadata[] };
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

function cloudflareSessionToken(projectRoot: string) {
  const configured = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (configured) return configured;
  try {
    const auth = JSON.parse(execFileSync('cf', ['auth', 'whoami'], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 12_000
    }));
    const name = auth.profile?.name;
    if (!auth.authenticated || typeof name !== 'string' || !/^[\w-]+$/u.test(name)) throw new Error();
    const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    const profile = JSON.parse(readFileSync(join(configDir, 'cloudflare', 'config', name + '.json'), 'utf8'));
    if (typeof profile.oauth_token === 'string' && profile.oauth_token.trim()) return profile.oauth_token.trim();
  } catch {
    // Do not expose authentication errors or profile data from this probe.
  }
  throw new Error('INBOUND_PRODUCTION_PREVIEW_METADATA_AUTH_UNAVAILABLE');
}

export async function assertLiveNativePreview(
  target: CloudflareTarget, source: { previewDeploymentId: string; previewBuildLabel: string }, projectRoot: string
) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account || !/^[a-f0-9]{32}$/u.test(account)) throw new Error('INBOUND_PRODUCTION_ACCOUNT_NOT_VERIFIED');
  const token = cloudflareSessionToken(projectRoot);
  const workers = '/accounts/' + account + '/workers/workers/';
  const get = async <T>(path: string) => {
    const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8_000), redirect: 'error'
    });
    if (!response.ok) throw new Error('INBOUND_PRODUCTION_PREVIEW_METADATA_UNAVAILABLE');
    const envelope = await response.json() as { success: boolean; result: T };
    if (!envelope.success) throw new Error('INBOUND_PRODUCTION_PREVIEW_METADATA_UNAVAILABLE');
    return envelope.result;
  };
  const worker = await get<{ id?: string }>(workers + encodeURIComponent(target.name));
  if (!worker?.id) throw new Error('INBOUND_PRODUCTION_PREVIEW_DEPLOYMENT_CHANGED');
  const path = workers + encodeURIComponent(worker.id) + '/previews';
  const previews = await get<Array<{ id?: string; slug?: string }>>(path + '?slug=mail-ai');
  const preview = Array.isArray(previews) ? previews.find(entry => entry.slug === 'mail-ai') : null;
  if (!preview?.id) throw new Error('INBOUND_PRODUCTION_PREVIEW_DEPLOYMENT_CHANGED');
  const latest = await get<{ id?: string; env?: Record<string, { text?: string; database_id?: string; id?: string; bucket_name?: string }> }>(
    path + '/' + encodeURIComponent(preview.id) + '/deployments/latest?include=bindings'
  );
  const env = latest?.env;
  if (latest?.id !== source.previewDeploymentId || env?.APP_ENV?.text !== 'preview' || env?.APP_VERSION?.text !== source.previewBuildLabel ||
      routingD1Id(env?.DB?.database_id ?? env?.DB?.id) !== routingD1Id(target.preInbound?.databaseId) ||
      env?.BUCKET?.bucket_name !== target.preInbound?.bucket ||
      routingD1Id(env?.INBOUND_ROUTING_DB?.database_id ?? env?.INBOUND_ROUTING_DB?.id) !== routingD1Id(target.inboundRouting?.databaseId)) {
    throw new Error('INBOUND_PRODUCTION_PREVIEW_DEPLOYMENT_CHANGED');
  }
}

export function assertActiveProductionForPreview(target: CloudflareTarget, source: ReturnType<typeof assertSharedInboundPreview>) {
  const { binding, db, bucket, settings } = requireActiveProductionVersion(target.name, source.deploymentId);
  if (db('DB') !== source.productionDb || bucket('BUCKET') !== source.productionBucket) {
    throw new Error('INBOUND_PREVIEW_PREFLIGHT_INVALID');
  }
  if (source.expectsDelivery) {
    if (!settings || db('INBOUND_ROUTING_DB') !== routingD1Id(target.inboundRouting?.databaseId) ||
        db('PRE_INBOUND_DB') !== routingD1Id(target.databaseId) || bucket('PRE_INBOUND_BUCKET') !== target.bucket ||
        fixedReservationHash(settings.recipient ?? undefined) !== fixedReservationHash(target.vars.PRE_INBOUND_RECIPIENT)) {
      throw new Error('INBOUND_PREVIEW_PREFLIGHT_INVALID');
    }
  } else if (['INBOUND_ROUTING_DB', 'INBOUND_ROUTING_SCOPE', 'PRE_INBOUND_SETTINGS', 'PRE_INBOUND_DB', 'PRE_INBOUND_BUCKET'].some(name => binding(name))) {
    throw new Error('INBOUND_PREVIEW_PREFLIGHT_INVALID');
  }
  if (source.managementEnabled && settings?.enabled !== true) throw new Error('INBOUND_PREVIEW_MANAGEMENT_REQUIRES_ACTIVE_DELIVERY');
}

export function assertActiveProductionForRelease(target: CloudflareTarget, source: ReturnType<typeof assertSharedInboundProduction>) {
  const { version, binding, db, bucket, settings } = requireActiveProductionVersion(target.name, source.deploymentId);
  if (db('DB') !== routingD1Id(target.databaseId) || bucket('BUCKET') !== target.bucket) {
    throw new Error('INBOUND_PRODUCTION_DEPLOYMENT_CHANGED');
  }
  const existingRegistry = db('INBOUND_ROUTING_DB');
  if (source.protectVersionId || source.maintaining || existingRegistry || binding('PRE_INBOUND_SETTINGS')) {
    if (!settings || existingRegistry !== routingD1Id(target.inboundRouting?.databaseId) ||
        db('PRE_INBOUND_DB') !== routingD1Id(target.preInbound?.databaseId) || bucket('PRE_INBOUND_BUCKET') !== target.preInbound?.bucket ||
        fixedReservationHash(settings.recipient ?? undefined) !== fixedReservationHash(target.vars.PRE_INBOUND_RECIPIENT) ||
        (source.protectVersionId && (version.id !== source.protectVersionId || settings.enabled !== false)) ||
        (source.maintaining && settings.enabled !== true)) {
      throw new Error('INBOUND_PRODUCTION_ACTIVE_PROTECTION_REQUIRED');
    }
  }
}
