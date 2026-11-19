import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { CloudflareTarget } from './cloudflare-target';

export function sharedInboundPreviewTargetHash(target: CloudflareTarget) {
  return createHash('sha256').update(JSON.stringify(target)).digest('hex');
}

export function assertSharedInboundPreview(target: CloudflareTarget, receiptPath: string) {
  const file = statSync(receiptPath);
  if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error('INBOUND_PREVIEW_PREFLIGHT_INVALID');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (!receipt || typeof receipt !== 'object') throw new Error('INBOUND_PREVIEW_PREFLIGHT_INVALID');
  const age = Date.now() - Date.parse(receipt.checkedAt);
  if (receipt.previewName !== 'mail-ai' || receipt.workerName !== target.name ||
      receipt.accountId !== process.env.CLOUDFLARE_ACCOUNT_ID || !/^[a-f0-9]{32}$/u.test(receipt.accountId) ||
      !receipt.production?.deploymentId || !receipt.preview?.deploymentId || !(age >= 0 && age < 10 * 60_000) ||
      receipt.targetHash !== sharedInboundPreviewTargetHash(target) ||
      receipt.preview.databaseId !== target.databaseId || receipt.preview.bucket !== target.bucket ||
      !receipt.production.databaseId || !receipt.production.bucket ||
      receipt.production.databaseId === target.databaseId || receipt.production.bucket === target.bucket ||
      receipt.routingDatabaseId !== target.inboundRouting?.databaseId ||
      receipt.routingDatabaseId === receipt.production.databaseId || receipt.routingDatabaseId === target.databaseId ||
      receipt.registryVerified !== true || receipt.previewBaseVerified !== true || target.cron.length !== 0 ||
      ['AUTO_REPLY_ENABLED', 'INBOUND_NOTIFICATION_ENABLED', 'TELEGRAM_ENABLED'].some(key => target.vars[key] !== 'false') ||
      Object.hasOwn(target.vars, 'CLOUDFLARE_EMAIL_ROUTING_TOKEN') ||
      target.secrets?.includes('CLOUDFLARE_EMAIL_ROUTING_TOKEN')) {
    throw new Error('INBOUND_PREVIEW_PREFLIGHT_INVALID');
  }
}
