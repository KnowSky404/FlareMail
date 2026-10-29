import { adapterOptions } from './adapter-config.mjs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createDeployInvocation, parseDeployMode, requireDeployConfig, normalizeDeployArguments } from './deploy-command';
import { createD1Command, localDatabaseId, executeD1, normalizeD1Output, readCloudflareTarget } from './cloudflare-target';

describe('global cf commands', () => {
  test('separates production uploads from an offline prebuilt dry run', () => {
    const environment = { CLOUDFLARE_API_TOKEN: 'test-placeholder', PATH: '/global/bin' };
    expect(createDeployInvocation('deploy', environment)).toEqual({ command: 'cf', args: ['deploy', '--mode', 'production', '--provision=false'], env: environment });
    expect(createDeployInvocation('dry-run', environment).args).toEqual(['deploy', '--prebuilt', '--dry-run', '--provision=false']);
  });
  test('fails closed for unsupported modes and missing private targets', () => {
    expect(() => parseDeployMode('preview')).toThrow('Unsupported deploy mode');
    expect(() => requireDeployConfig('cloudflare.deploy.json', () => false)).toThrow('Missing cloudflare.deploy.json');
    expect(() => readCloudflareTarget('cloudflare.local.json', true)).toThrow('Remote commands require');
  });
  test('uses cf raw SQL with an explicit local ID and isolated state', () => {
    expect(createD1Command({ persistTo: '/tmp/cf-fixture-state' }, 'SELECT 1')).toEqual([
      'cf', 'd1', 'raw', localDatabaseId, '--sql', 'SELECT 1', '--local', '--persist-to', '/tmp/cf-fixture-state'
    ]);
    expect(() => createD1Command({ database: 'another-database' }, 'SELECT 1')).toThrow('must match');
    const batch = createD1Command({}, ['SELECT 1', 'SELECT 2']);
    expect(batch).toContain('--batch');
    expect(JSON.parse(batch[batch.indexOf('--batch') + 1]!)).toEqual([{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }]);
  });
  test('preserves named columns, nulls, batch results and metadata from cf raw', () => {
    expect(normalizeD1Output([{ success: true, results: { columns: ['value'], rows: [[42]] }, meta: { changes: 1 } }])).toEqual([{ success: true, results: [{ value: 42 }], meta: { changes: 1 } }]);
    expect(normalizeD1Output({ result: [{ columns: ['name', 'count'], rows: [['fixture', 2], [null, 0]], meta: { changes: 1 } }] })).toEqual({ result: [{ columns: ['name', 'count'], rows: [['fixture', 2], [null, 0]], results: [{ name: 'fixture', count: 2 }, { name: null, count: 0 }], meta: { changes: 1 } }] });
  });
});


test('normalizes secret files from the caller directory and rejects policy overrides', () => {
  expect(normalizeDeployArguments(['--secrets-file', '../release-secrets.json'], '/workspace/app')).toEqual(['--secrets-file', '/workspace/release-secrets.json']);
  expect(normalizeDeployArguments(['--secrets-file=../release-secrets.json'], '/workspace/app')).toEqual(['--secrets-file=/workspace/release-secrets.json']);
  expect(() => normalizeDeployArguments(['--secrets-file'])).toThrow('requires a path');
  expect(() => normalizeDeployArguments(['--provision=true'])).toThrow('controlled by this script');
});


test('cf consumes protected SQL files without inline query data in argv', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaremail-d1-file-'));
  try {
    const file = join(directory, 'credential request.sql');
    await writeFile(file, 'SELECT 42 AS safe_transport', { mode: 0o600 });
    const options = { config: 'cloudflare.local.json', persistTo: join(directory, 'state') };
    const command = createD1Command(options, `@${file}`);
    expect(command).toContain(`@${file}`);
    expect(command.join(' ')).not.toContain('safe_transport');
    const previous = process.env.FLAREMAIL_CF_CONFIG;
    try {
      process.env.FLAREMAIL_CF_CONFIG = '/does-not-exist-unrelated-worker-target.json';
      const results = JSON.parse(await executeD1(options, `@${file}`));
      expect(results[0].results[0].safe_transport).toBe(42);
    } finally {
      if (previous === undefined) delete process.env.FLAREMAIL_CF_CONFIG;
      else process.env.FLAREMAIL_CF_CONFIG = previous;
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

test('the HMR adapter honors selected local targets while builds use the public target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaremail-adapter-target-'));
  const previous = process.env.FLAREMAIL_CF_CONFIG;
  try {
    const target = JSON.parse(await readFile('cloudflare.local.json', 'utf8'));
    target.vars.OUTBOUND_FROM_NAME = 'Private local test';
    target.databaseId = '11111111-1111-4111-8111-111111111111';
    target.bucket = 'private-local-fixture';
    target.secrets = ['SYNTHETIC_LOCAL_SECRET'];
    const file = join(directory, 'local.json');
    await writeFile(file, JSON.stringify(target), { mode: 0o600 });
    process.env.FLAREMAIL_CF_CONFIG = file;
    const development = adapterOptions(true);
    const generated = JSON.parse(await readFile(development.config, 'utf8'));
    expect(generated.vars.OUTBOUND_FROM_NAME).toBe('Private local test');
    expect(generated.d1_databases[0].database_id).toBe(target.databaseId);
    expect(generated.r2_buckets[0].bucket_name).toBe(target.bucket);
    expect(generated.secrets.required).toEqual(['SYNTHETIC_LOCAL_SECRET']);
    const build = adapterOptions(false);
    expect(JSON.parse(await readFile(build.config, 'utf8')).d1_databases[0].database_id).toBe(localDatabaseId);
    target.vars.APP_ENV = 'production';
    await writeFile(file, JSON.stringify(target), { mode: 0o600 });
    expect(() => adapterOptions(true)).toThrow('Local commands require');
  } finally {
    if (previous === undefined) delete process.env.FLAREMAIL_CF_CONFIG;
    else process.env.FLAREMAIL_CF_CONFIG = previous;
    adapterOptions(false);
    await rm(directory, { recursive: true, force: true });
  }
});
