import { describe, expect, test } from 'bun:test';
import { createDeployInvocation, parseDeployMode, requireDeployConfig } from './deploy-command';
import { createD1Command, localDatabaseId, normalizeD1Output, readCloudflareTarget } from './cloudflare-target';

describe('global cf commands', () => {
  test('separates production uploads from an offline prebuilt dry run', () => {
    const environment = { CLOUDFLARE_API_TOKEN: 'test-placeholder', PATH: '/global/bin' };
    expect(createDeployInvocation('deploy', environment)).toEqual({ command: 'cf', args: ['deploy', '--mode', 'production'], env: environment });
    expect(createDeployInvocation('dry-run', environment).args).toEqual(['deploy', '--prebuilt', '--dry-run']);
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
