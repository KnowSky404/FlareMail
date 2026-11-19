import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CloudflareTarget } from './cloudflare-target.ts';

export function sharedInboundPreviewTargetHash(target: CloudflareTarget) {
  return createHash('sha256').update(JSON.stringify(target)).digest('hex');
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
  if (receipt.previewName !== 'mail-ai' || receipt.workerName !== target.name ||
      !receipt.production?.deploymentId || !receipt.preview?.deploymentId ||
      receipt.targetHash !== sharedInboundPreviewTargetHash(target) ||
      !previewDb || !productionDb || !registry || new Set([previewDb, productionDb, registry]).size !== 3 ||
      routingD1Id(receipt.preview.databaseId) !== previewDb || routingD1Id(receipt.routingDatabaseId) !== registry ||
      receipt.preview.bucket !== target.bucket || !receipt.production.bucket || receipt.production.bucket === target.bucket ||
      (delivery !== null && (routingD1Id(delivery?.databaseId) !== previewDb || delivery?.bucket !== target.bucket ||
        routingD1Id(delivery?.routingDatabaseId) !== registry)) ||
      receipt.registryVerified !== true || receipt.previewBaseVerified !== true || target.cron.length !== 0 ||
      ['AUTO_REPLY_ENABLED', 'INBOUND_NOTIFICATION_ENABLED', 'TELEGRAM_ENABLED'].some(key => target.vars[key] !== 'false') ||
      Object.hasOwn(target.vars, 'CLOUDFLARE_EMAIL_ROUTING_TOKEN') ||
      target.secrets?.includes('CLOUDFLARE_EMAIL_ROUTING_TOKEN')) {
    throw new Error('INBOUND_PREVIEW_PREFLIGHT_INVALID');
  }
}

export function assertSharedInboundProduction(target: CloudflareTarget, receiptPath: string) {
  const errorCode = 'INBOUND_PRODUCTION_PREFLIGHT_INVALID';
  const receipt = readRecentReceipt(receiptPath, errorCode);
  const productionDb = routingD1Id(target.databaseId);
  const previewDb = routingD1Id(target.preInbound?.databaseId);
  const registry = routingD1Id(target.inboundRouting?.databaseId);
  const phase = target.vars.PRE_INBOUND_ENABLED === 'false' ? 'protect' : 'activate';
  if (receipt.phase !== phase || receipt.workerName !== target.name || receipt.previewName !== 'mail-ai' ||
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
      receipt.registryVerified !== true || receipt.versionUrlsDisabled !== true || receipt.legacyOperationsQuiesced !== true ||
      (phase === 'activate' && (!receipt.protectVersionId || receipt.protectionActive !== true ||
        receipt.mailRoutesAndMappingsVerified !== true || receipt.preCatchAllsVerified !== true))) {
    throw new Error(errorCode);
  }
  return { releaseCommit: receipt.releaseCommit as string, acceptedPreviewCommit: receipt.acceptedPreviewCommit as string };
}

export function assertProductionReleaseSource(projectRoot: string, source: { releaseCommit: string; acceptedPreviewCommit: string }) {
  const git = (args: string[]) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git(['rev-parse', 'HEAD']) !== source.releaseCommit || git(['status', '--porcelain'])) {
    throw new Error('INBOUND_PRODUCTION_RELEASE_SOURCE_NOT_VERIFIED');
  }
  try {
    if (git(['rev-parse', source.releaseCommit + '^{tree}']) === git(['rev-parse', source.acceptedPreviewCommit + '^{tree}'])) return;
  } catch {
    // A missing accepted source revision is also insufficient release evidence.
  }
  throw new Error('INBOUND_PRODUCTION_RELEASE_DIFFERS_FROM_PRE_ACCEPTANCE');
}

export function assertLegacyProductionHasNoActiveInboundProtection(worker: string) {
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
      if (/\[10007\].*worker does not exist/iu.test(stderr) && /\b404 Not Found\b/u.test(stderr)) return;
      throw new Error('INBOUND_PRODUCTION_ACTIVE_BINDINGS_UNAVAILABLE');
    }
    if (!Array.isArray(deployments)) throw new Error('INBOUND_PRODUCTION_ACTIVE_BINDINGS_UNAVAILABLE');
    if (!deployments.length) return;
    const versions = deployments[0].versions;
    const activeVersions = Array.isArray(versions) ? versions.filter(item => item.percentage > 0) : [];
    if (!activeVersions.length || activeVersions.some(item => !routingD1Id(item.version_id))) {
      throw new Error('INBOUND_PRODUCTION_ACTIVE_BINDINGS_UNAVAILABLE');
    }
    for (const version of activeVersions) {
      let bindings;
      try {
        const metadata = cf(['workers', 'versions', 'get', version.version_id, '--worker', worker]);
        bindings = metadata.bindings ?? metadata.resources?.bindings;
      } catch {
        throw new Error('INBOUND_PRODUCTION_ACTIVE_BINDINGS_UNAVAILABLE');
      }
      if (!Array.isArray(bindings)) throw new Error('INBOUND_PRODUCTION_ACTIVE_BINDINGS_UNAVAILABLE');
      if (bindings.some(binding => ['INBOUND_ROUTING_DB', 'INBOUND_ROUTING_SCOPE', 'PRE_INBOUND_SETTINGS'].includes(binding.name))) {
        throw new Error('INBOUND_PRODUCTION_ACTIVE_PROTECTION_REQUIRED');
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
