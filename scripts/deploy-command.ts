import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
export function normalizeDeployArguments(args: string[], callerDirectory = process.cwd()) {
  return args.map((argument, index) => {
    if (/^(?:--(?:mode|prebuilt|worker|config|provision)(?:=|$)|-m)/u.test(argument)) {
      throw new Error('The release mode, provisioning policy and build target are controlled by this script.');
    }
    if (argument === '--secrets-file') {
      if (!args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error('--secrets-file requires a path.');
      return argument;
    }
    if (args[index - 1] === '--secrets-file') return resolve(callerDirectory, argument);
    if (argument.startsWith('--secrets-file=')) {
      const path = argument.slice('--secrets-file='.length);
      if (!path) throw new Error('--secrets-file requires a path.');
      return `--secrets-file=${resolve(callerDirectory, path)}`;
    }
    return argument;
  });
}

export function createDeployInvocation(mode: DeployMode, environment = process.env, args: string[] = []) {
  return {
    command: 'cf',
    args: mode === 'dry-run'
      ? ['deploy', '--prebuilt', '--dry-run', '--provision=false']
      : ['deploy', '--mode', 'production', '--provision=false', ...normalizeDeployArguments(args)],
    env: { ...environment }
  };
}
