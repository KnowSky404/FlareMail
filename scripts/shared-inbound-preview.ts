import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { CloudflareTarget } from './cloudflare-target.ts';

export function sharedInboundPreviewTargetHash(target: CloudflareTarget) {
  return createHash('sha256').update(JSON.stringify(target)).digest('hex');
}

function routingD1Id(value: unknown) {
  return typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(value) ? value.toLowerCase() : null;
}

export function assertSharedInboundPreview(target: CloudflareTarget, receiptPath: string) {
  const file = statSync(receiptPath);
  if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error('INBOUND_PREVIEW_PREFLIGHT_INVALID');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (!receipt || typeof receipt !== 'object') throw new Error('INBOUND_PREVIEW_PREFLIGHT_INVALID');
  const age = Date.now() - Date.parse(receipt.checkedAt);
  const previewDb = routingD1Id(target.databaseId);
  const productionDb = routingD1Id(receipt.production?.databaseId);
  const registry = routingD1Id(target.inboundRouting?.databaseId);
  if (receipt.previewName !== 'mail-ai' || receipt.workerName !== target.name ||
      receipt.accountId !== process.env.CLOUDFLARE_ACCOUNT_ID || !/^[a-f0-9]{32}$/u.test(receipt.accountId) ||
      !receipt.production?.deploymentId || !receipt.preview?.deploymentId || !(age >= 0 && age < 10 * 60_000) ||
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
