import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CloudflareTarget {
  name: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  vars: Record<string, string>;
  databaseId: string;
  databaseName: string;
  bucket: string;
  cron: string[];
  secrets?: string[];
  observability?: { enabled: boolean };
}

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const defaultStatePath = resolve(projectRoot, '.cloudflare/state');
export const localDatabaseId = '00000000-0000-4000-8000-000000000001';

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
  return value;
}

export function readCloudflareTarget(config = process.env.FLAREMAIL_CF_CONFIG ?? 'cloudflare.local.json', remote = false): CloudflareTarget {
  const target = parseCloudflareTarget(readFileSync(resolve(projectRoot, config), 'utf8'));
  const local = ['development', 'test'].includes(target.vars.APP_ENV);
  if (remote) {
    if (!['production', 'preview'].includes(target.vars.APP_ENV) || local || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(target.databaseId) ||
        target.databaseId === localDatabaseId || /^[0-]*$/u.test(target.databaseId) || /replace|placeholder/iu.test(target.bucket)) {
      throw new Error('Remote commands require an explicit target with real D1/R2 bindings.');
    }
  } else if (!local) throw new Error('Local commands require an APP_ENV=development or test target.');
  return target;
}

export function localStateArgs(persistTo?: string) {
  return ['--local', '--persist-to', resolve(projectRoot, persistTo ?? process.env.FLAREMAIL_STATE_DIR ?? defaultStatePath)];
}

export function createD1Command(options: { remote?: boolean; config?: string; database?: string; persistTo?: string }, sql: string | string[]) {
  const target = readCloudflareTarget(options.config, options.remote);
  if (options.database && ![target.databaseId, target.databaseName, 'DB'].includes(options.database)) {
    throw new Error('--database must match the selected target D1 binding.');
  }
  return ['cf', 'd1', 'raw', target.databaseId, ...(Array.isArray(sql) ? ['--batch', JSON.stringify(sql.map((statement) => ({ sql: statement })))] : ['--sql', sql]),
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
