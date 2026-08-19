import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLocalWranglerEnvironment, inheritWranglerEnvironment } from './wrangler-environment';

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

const tomlString = (value: string) => JSON.stringify(value);

/**
 * Turn the checked-in local Wrangler config into a self-contained dry-run
 * config. Wrangler resolves paths relative to the config file, so a config
 * written under the operating-system temp directory must use absolute paths.
 * The checked-in source contains no secrets or production resource IDs.
 */
export function createCiDryRunConfig(
  source: string,
  projectRoot: string,
  resolvePath: (...parts: string[]) => string = resolve
) {
  const replacements: Array<[RegExp, string, string]> = [
    [/^main\s*=\s*"[^"]+"\s*$/mu, `main = ${tomlString(resolvePath(projectRoot, 'worker/index.ts'))}`, 'main'],
    [/^directory\s*=\s*"build"\s*$/mu, `directory = ${tomlString(resolvePath(projectRoot, 'build'))}`, 'assets directory'],
    [/^migrations_dir\s*=\s*"migrations"\s*$/mu, `migrations_dir = ${tomlString(resolvePath(projectRoot, 'migrations'))}`, 'migrations directory']
  ];
  let generated = source;
  for (const [pattern, replacement, label] of replacements) {
    if (!pattern.test(generated)) throw new Error(`Unable to locate ${label} in the public Wrangler config.`);
    generated = generated.replace(pattern, replacement);
  }
  return `${generated.trimEnd()}\n`;
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
    env: mode === 'dry-run'
      ? createLocalWranglerEnvironment(options.environment, {
          temporaryDirectory: options.temporaryDirectory,
          joinPath: options.joinPath,
          logFileName: 'flaremail-deploy-dry-run.log'
        })
      : inheritWranglerEnvironment(options.environment),
    outdir
  };
}
