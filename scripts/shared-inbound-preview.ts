import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  if (receipt.previewName !== 'mail-ai' || receipt.workerName !== target.name ||
      !receipt.production?.deploymentId || !receipt.preview?.deploymentId ||
      receipt.targetHash !== sharedInboundPreviewTargetHash(target) ||
      !previewDb || !productionDb || !registry || new Set([previewDb, productionDb, registry]).size !== 3 ||
      routingD1Id(receipt.preview.databaseId) !== previewDb || routingD1Id(receipt.routingDatabaseId) !== registry ||
      receipt.preview.bucket !== target.bucket || !receipt.production.bucket || receipt.production.bucket === target.bucket ||
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
      (phase === 'activate' && (!receipt.protectVersionId || receipt.protectionActive !== true || receipt.mailRoutesAndMappingsVerified !== true))) {
    throw new Error(errorCode);
  }
}
