import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import {
  createDeployInvocation,
  parseDeployMode,
  requireDeployConfig
} from './deploy-command';
import {
  createLocalWranglerEnvironment,
  inheritWranglerEnvironment
} from './wrangler-environment';

describe('cross-platform Wrangler commands', () => {
  test('constructs strict deploy and dry-run modes without changing authentication state', () => {
    const authEnvironment = {
      CLOUDFLARE_API_TOKEN: 'redacted-test-token',
      XDG_CONFIG_HOME: '/operator/config'
    };
    const deploy = createDeployInvocation('deploy', { environment: authEnvironment });
    expect(deploy.args).toEqual([
      'x', 'wrangler', 'deploy', '--strict', '--config', 'wrangler.deploy.toml'
    ]);
    expect(deploy.outdir).toBeNull();
    expect(deploy.env).toEqual(authEnvironment);

    const dryRun = createDeployInvocation('dry-run', {
      environment: authEnvironment,
      temporaryDirectory: '/portable-temp'
    });
    expect(dryRun.args).toContain('--dry-run');
    expect(dryRun.args).toContain('--outdir');
    expect(dryRun.outdir).toBe('/portable-temp/flaremail-dry-run');
    expect(dryRun.env).toEqual(authEnvironment);

    const defaultDryRun = createDeployInvocation('dry-run', { environment: {} });
    expect(defaultDryRun.outdir).toBe(join(tmpdir(), 'flaremail-dry-run'));
  });

  test('uses the supplied platform path implementation for Windows temporary output', () => {
    const invocation = createDeployInvocation('dry-run', {
      environment: {},
      temporaryDirectory: 'C:\\Users\\operator\\AppData\\Local\\Temp',
      joinPath: win32.join
    });
    expect(invocation.outdir).toBe(
      'C:\\Users\\operator\\AppData\\Local\\Temp\\flaremail-dry-run'
    );
    expect(invocation.env.XDG_CONFIG_HOME).toBeUndefined();
  });

  test('inherits remote credentials exactly and isolates only explicit local commands', () => {
    expect(inheritWranglerEnvironment({ CLOUDFLARE_API_TOKEN: 'redacted' })).toEqual({
      CLOUDFLARE_API_TOKEN: 'redacted'
    });
    expect(createLocalWranglerEnvironment({}, {
      temporaryDirectory: '/portable-temp'
    })).toEqual({
      XDG_CONFIG_HOME: '/portable-temp/flaremail-wrangler-config',
      WRANGLER_LOG_PATH: '/portable-temp/flaremail-wrangler.log'
    });
  });

  test('fails closed for unknown modes and a missing private deployment config', () => {
    expect(() => parseDeployMode('preview')).toThrow('Unsupported deploy mode');
    expect(() => requireDeployConfig('wrangler.deploy.toml', () => false)).toThrow(
      'Missing wrangler.deploy.toml.'
    );
    expect(requireDeployConfig('wrangler.deploy.toml', () => true)).toBe(
      'wrangler.deploy.toml'
    );
  });
});
