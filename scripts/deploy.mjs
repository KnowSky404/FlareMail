import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCiDryRunConfig,
  createDeployInvocation,
  parseDeployMode,
  requireDeployConfig
} from './deploy-command.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateConfigPath = join(projectRoot, 'wrangler.deploy.toml');
let temporaryDirectory = null;
const cleanup = () => {
  if (!temporaryDirectory) return;
  rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = null;
};
try {
  const mode = parseDeployMode(process.argv[2]);
  let configPath = privateConfigPath;
  if (mode === 'dry-run') {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'flaremail-dry-run-'));
    configPath = join(temporaryDirectory, 'wrangler.ci.toml');
    const publicConfig = readFileSync(join(projectRoot, 'wrangler.toml'), 'utf8');
    writeFileSync(configPath, createCiDryRunConfig(publicConfig, projectRoot), { encoding: 'utf8', mode: 0o600 });
  } else {
    requireDeployConfig(configPath);
  }
  const invocation = createDeployInvocation(mode, { configPath, temporaryDirectory: temporaryDirectory ?? undefined });
  const child = spawn(invocation.command, invocation.args, {
    stdio: 'inherit',
    env: invocation.env
  });

  child.on('error', (error) => {
    cleanup();
    console.error(`Unable to start Wrangler: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    cleanup();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
} catch (error) {
  cleanup();
  console.error(error instanceof Error ? error.message : 'Unable to prepare deployment.');
  process.exit(1);
}
