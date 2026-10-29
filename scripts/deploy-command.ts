import { existsSync } from 'node:fs';

export type DeployMode = 'deploy' | 'dry-run';
export function parseDeployMode(value: string | undefined): DeployMode {
  if (value === undefined || value === 'deploy') return 'deploy';
  if (value === 'dry-run') return value;
  throw new Error(`Unsupported deploy mode: ${value}.`);
}
export function requireDeployConfig(path = 'cloudflare.deploy.json', fileExists = existsSync) {
  if (!fileExists(path)) throw new Error(`Missing ${path}. Copy cloudflare.deploy.json.example and fill in the real bindings.`);
  return path;
}
export function createDeployInvocation(mode: DeployMode, environment = process.env) {
  return {
    command: 'cf',
    args: mode === 'dry-run' ? ['deploy', '--prebuilt', '--dry-run'] : ['deploy', '--mode', 'production'],
    env: { ...environment }
  };
}
