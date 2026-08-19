import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inheritWranglerEnvironment } from './wrangler-environment';

export type DeployMode = 'deploy' | 'dry-run';

export function parseDeployMode(value: string | undefined): DeployMode {
  if (value === undefined || value === 'deploy') return 'deploy';
  if (value === 'dry-run') return 'dry-run';
  throw new Error(`Unsupported deploy mode: ${value}.`);
}

export function requireDeployConfig(
  configPath = 'wrangler.deploy.toml',
  fileExists: (path: string) => boolean = existsSync
) {
  if (!fileExists(configPath)) {
    throw new Error([
      `Missing ${configPath}.`,
      'Copy wrangler.deploy.toml.example to wrangler.deploy.toml and fill in your real Cloudflare bindings before deploying.'
    ].join('\n'));
  }
  return configPath;
}

export function createDeployInvocation(
  mode: DeployMode,
  options: {
    configPath?: string;
    environment?: Record<string, string | undefined>;
    temporaryDirectory?: string;
    joinPath?: (...parts: string[]) => string;
  } = {}
) {
  const configPath = options.configPath ?? 'wrangler.deploy.toml';
  const args = ['x', 'wrangler', 'deploy', '--strict', '--config', configPath];
  let outdir: string | null = null;
  if (mode === 'dry-run') {
    outdir = (options.joinPath ?? join)(
      options.temporaryDirectory ?? tmpdir(),
      'flaremail-dry-run'
    );
    args.push('--dry-run', '--outdir', outdir);
  }
  return {
    command: 'bun',
    args,
    env: inheritWranglerEnvironment(options.environment),
    outdir
  };
}
