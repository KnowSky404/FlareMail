import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertLegacyProductionHasNoActiveInboundProtection, assertProductionReleaseSource,
  assertSharedInboundPreview, assertSharedInboundProduction
} from './shared-inbound-preview.ts';
import { normalizePreInboundRecipient, PRE_INBOUND_BINDING_NAMES, readPreInboundConfig } from '../src/lib/server/inbound/pre-inbound.ts';

interface D1Target {
  databaseId: string;
  databaseName: string;
}

interface PreInboundStorage extends D1Target {
  bucket: string;
}

export interface CloudflareTarget {
  name: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  vars: Record<string, string>;
  databaseId: string;
  databaseName: string;
  bucket: string;
  preInbound?: PreInboundStorage;
  inboundRouting?: D1Target & { environment: 'production' | 'preview' };
  cron: string[];
  secrets?: string[];
  observability?: { enabled: boolean };
}

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const defaultStatePath = resolve(projectRoot, '.cloudflare/state');
export const localDatabaseId = '00000000-0000-4000-8000-000000000001';
const databaseIdPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;

const isRemoteDatabaseId = (id: string) =>
  databaseIdPattern.test(id) && id !== localDatabaseId && !/^[0-]*$/u.test(id);

function isFixedPreviewApp(target: CloudflareTarget) {
  return target.vars.APP_ENV !== 'production' && target.inboundRouting?.environment !== 'production' &&
    !target.preInbound && target.vars.PRE_INBOUND_ENABLED === undefined && target.vars.PRE_INBOUND_RECIPIENT !== undefined;
}

export function cloudflarePreInboundSettings(target: CloudflareTarget) {
  const previewApp = isFixedPreviewApp(target);
  if (!target.preInbound && !previewApp) return null;
  return {
    recipient: Object.hasOwn(target.vars, 'PRE_INBOUND_RECIPIENT') ? target.vars.PRE_INBOUND_RECIPIENT : null,
    enabled: target.vars.PRE_INBOUND_ENABLED === 'true',
    ...(previewApp ? { previewApp: true as const } : {})
  };
}

export function parseCloudflareTarget(source: string): CloudflareTarget {
  const value = JSON.parse(source) as CloudflareTarget;
  if (!value || typeof value !== 'object' || !value.vars || typeof value.vars !== 'object' ||
      Array.isArray(value.vars) || !Object.values(value.vars).every((item) => typeof item === 'string') ||
      typeof value.name !== 'string' || typeof value.databaseName !== 'string' ||
      typeof value.compatibilityDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value.compatibilityDate) ||
      !Array.isArray(value.compatibilityFlags) || !value.compatibilityFlags.every((flag) => typeof flag === 'string') ||
      typeof value.databaseId !== 'string' || typeof value.bucket !== 'string' ||
      !Array.isArray(value.cron) || !value.cron.every((schedule) => typeof schedule === 'string') ||
      (value.secrets !== undefined && (!Array.isArray(value.secrets) || !value.secrets.every((name) => typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(name))))) {
    throw new Error('Invalid Cloudflare target configuration.');
  }
  const { PRE_INBOUND_RECIPIENT, PRE_INBOUND_ENABLED } = value.vars;
  const pre = value.preInbound;
  const routing = value.inboundRouting;
  const appEnv = value.vars.APP_ENV;
  const hasPreStorage = pre !== undefined;
  if (hasPreStorage && (!pre || typeof pre !== 'object' || typeof pre.databaseId !== 'string' ||
      !databaseIdPattern.test(pre.databaseId) || typeof pre.databaseName !== 'string' || !pre.databaseName.trim() ||
      typeof pre.bucket !== 'string' || !pre.bucket.trim() || pre.bucket !== pre.bucket.trim() ||
      pre.databaseId.toLowerCase() === value.databaseId.toLowerCase() || pre.bucket.toLowerCase() === value.bucket.toLowerCase())) {
    throw new Error('PRE_INBOUND_STORAGE_CONFIGURATION_INVALID');
  }
  if (routing !== undefined && (!routing || typeof routing !== 'object' ||
      typeof routing.databaseId !== 'string' || !databaseIdPattern.test(routing.databaseId) ||
      typeof routing.databaseName !== 'string' || !routing.databaseName.trim() ||
      (routing.environment !== 'production' && routing.environment !== 'preview') ||
      (['production', 'preview'].includes(appEnv) && routing.environment !== appEnv) ||
      [value.databaseId, pre?.databaseId].some((id) => id?.toLowerCase() === routing.databaseId.toLowerCase()))) {
    throw new Error('INBOUND_ROUTING_CONFIGURATION_INVALID');
  }
  const bindingNames = [...PRE_INBOUND_BINDING_NAMES, 'INBOUND_ROUTING_DB', 'INBOUND_ROUTING_SCOPE'];
  if (value.secrets?.some((name) => [...bindingNames, 'PRE_INBOUND_RECIPIENT', 'PRE_INBOUND_ENABLED'].includes(name)) ||
      bindingNames.some((name) => Object.hasOwn(value.vars, name))) {
    throw new Error('PRE_INBOUND_CONFIGURATION_INVALID');
  }
  if (appEnv === 'preview' || routing?.environment === 'preview' || isFixedPreviewApp(value)) {
    if (hasPreStorage || PRE_INBOUND_ENABLED !== undefined) throw new Error('PRE_INBOUND_CONFIGURATION_INVALID');
    if (PRE_INBOUND_RECIPIENT !== undefined) normalizePreInboundRecipient(PRE_INBOUND_RECIPIENT);
  } else {
    readPreInboundConfig({ PRE_INBOUND_RECIPIENT, PRE_INBOUND_ENABLED }, hasPreStorage, hasPreStorage, Boolean(routing));
  }
  return value;
}

export function readCloudflareTarget(config = process.env.FLAREMAIL_CF_CONFIG ?? 'cloudflare.local.json', remote = false): CloudflareTarget {
  const target = parseCloudflareTarget(readFileSync(resolve(projectRoot, config), 'utf8'));
  const local = ['development', 'test'].includes(target.vars.APP_ENV);
  if (remote) {
    if (!['production', 'preview'].includes(target.vars.APP_ENV) || !isRemoteDatabaseId(target.databaseId) ||
        /replace|placeholder/iu.test(target.bucket) || (target.preInbound &&
        (!isRemoteDatabaseId(target.preInbound.databaseId) || /replace|placeholder/iu.test(target.preInbound.bucket))) ||
        (target.inboundRouting && !isRemoteDatabaseId(target.inboundRouting.databaseId))) {
      throw new Error('Remote commands require an explicit target with real D1/R2 bindings.');
    }
  } else if (!local) throw new Error('Local commands require an APP_ENV=development or test target.');
  return target;
}

export function checkPreInboundRelease(target: CloudflareTarget, nativePreview = false) {
  if (target.vars.PRE_INBOUND_RECIPIENT === undefined && !target.inboundRouting) {
    if (target.vars.APP_ENV === 'production') assertLegacyProductionHasNoActiveInboundProtection(target.name);
    return;
  }
  if (nativePreview && target.vars.APP_ENV === 'preview' && target.inboundRouting &&
      target.vars.PRE_INBOUND_RECIPIENT === undefined && process.env.FLAREMAIL_INBOUND_PREVIEW_PREFLIGHT) {
    assertSharedInboundPreview(target, process.env.FLAREMAIL_INBOUND_PREVIEW_PREFLIGHT);
    return;
  }
  if (!nativePreview && target.vars.APP_ENV === 'production' && target.inboundRouting &&
      target.vars.PRE_INBOUND_RECIPIENT === undefined && process.env.FLAREMAIL_INBOUND_PRODUCTION_PREFLIGHT) {
    const source = assertSharedInboundProduction(target, process.env.FLAREMAIL_INBOUND_PRODUCTION_PREFLIGHT);
    assertProductionReleaseSource(projectRoot, source);
    return;
  }
  throw new Error('PRE_INBOUND_RELEASE_GUARDS_REQUIRED');
}

export function localStateArgs(persistTo?: string) {
  return ['--local', '--persist-to', resolve(projectRoot, persistTo ?? process.env.FLAREMAIL_STATE_DIR ?? defaultStatePath)];
}

export function createD1Command(options: { remote?: boolean; config?: string; database?: string; persistTo?: string; inboundRouting?: boolean }, sql: string | string[]) {
  const target = readCloudflareTarget(options.config, options.remote);
  const binding = options.inboundRouting ? target.inboundRouting : target;
  if (!binding || (options.inboundRouting && options.remote)) throw new Error('INBOUND_ROUTING_CONFIGURATION_INVALID');
  if (options.database && ![binding.databaseId, binding.databaseName, options.inboundRouting ? 'INBOUND_ROUTING_DB' : 'DB'].includes(options.database)) {
    throw new Error('--database must match the selected target D1 binding.');
  }
  return ['cf', 'd1', 'raw', binding.databaseId, ...(Array.isArray(sql) ? ['--batch', JSON.stringify(sql.map((statement) => ({ sql: statement })))] : ['--sql', sql]),
    ...(options.remote ? [] : localStateArgs(options.persistTo))];
}

/** Convert cf's raw column/value arrays to named rows for maintenance reports. */
export function normalizeD1Output(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeD1Output);
  if (!value || typeof value !== 'object') return value;
  const item = value as Record<string, unknown>;
  if (item.results && typeof item.results === 'object' && !Array.isArray(item.results)) {
    const raw = normalizeD1Output(item.results) as Record<string, unknown>;
    if (Array.isArray(raw.results)) return { ...item, results: raw.results };
  }
  if (Array.isArray(item.columns) && Array.isArray(item.rows)) {
    return { ...item, results: item.rows.map((row) => Object.fromEntries(
      (item.columns as string[]).map((column, index) => [column, (row as unknown[])[index]])
    )) };
  }
  return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, normalizeD1Output(nested)]));
}

export async function executeD1(options: Parameters<typeof createD1Command>[0], sql: string | string[]) {
  const child = Bun.spawn(createD1Command(options, sql), { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
  ]);
  if (code !== 0) throw new Error(`cf D1 command failed (${code}).`);
  return JSON.stringify(normalizeD1Output(JSON.parse(stdout)));
}
