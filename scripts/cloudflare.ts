import { createDeployInvocation, normalizeDeployArguments } from './deploy-command';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultStatePath, localStateArgs, projectRoot, readCloudflareTarget } from './cloudflare-target';

const [command, ...args] = process.argv.slice(2);
const cwd = command === 'build' || command === 'preview' || command === 'deploy' || command === 'pre' || command === 'dry-run' ? join(projectRoot, 'worker') : projectRoot;
const mode = command === 'deploy' ? 'production' : command === 'pre' ? 'preview' : 'development';
const environment: Record<string, string | undefined> = { ...process.env, FLAREMAIL_STATE_DIR: process.env.FLAREMAIL_STATE_DIR ?? defaultStatePath };
if (command === 'dry-run' || command === 'typegen') {
  environment.FLAREMAIL_CF_CONFIG = join(projectRoot, 'cloudflare.local.json');
  delete environment.FLAREMAIL_E2E;
}
async function run(argv: string[], workingDirectory = cwd) {
  const child = Bun.spawn(argv, {
    cwd: workingDirectory, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
    env: environment
  });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
if (command === 'typegen') {
  const output = join(projectRoot, '.cloudflare/types/index.d.ts');
  const before = args.includes('--check') ? await readFile(join(projectRoot, 'worker-configuration.d.ts'), 'utf8') : null;
  await run(['cf', 'workers', 'types', '--mode', 'development']);
  const types = (await readFile(output, 'utf8'))
    .replaceAll('cf/config', '@cloudflare/config/public')
    .replaceAll('../../cloudflare.config', './cloudflare.config');
  if (before !== null && types !== before) throw new Error('Worker binding types are stale; run bun run cf:typegen.');
  if (before === null) await writeFile(join(projectRoot, 'worker-configuration.d.ts'), types);
} else if (command === 'migrate') {
  const unknown = args.find((argument) => !['--remote', '--dry-run'].includes(argument));
  if (unknown) throw new Error(`Unknown migration option: ${unknown}`);
  const remote = args.includes('--remote');
  const target = readCloudflareTarget(process.env.FLAREMAIL_CF_CONFIG ?? (remote ? 'cloudflare.deploy.json' : 'cloudflare.local.json'), remote);
  await run(['cf', 'd1', 'migrations', 'apply', target.databaseId, '--dir', join(projectRoot, 'migrations'), ...(args.includes('--dry-run') ? ['--dry-run'] : []), ...(remote ? [] : localStateArgs())]);
} else if (command === 'build') {
  await run(['cf', 'build', '--mode', mode]);
} else if (command === 'preview') {
  await run(['cf', 'dev', '--mode', mode]);
} else if (command === 'dry-run') {
  // Force the public target for both stages; never consume a private PRE build.
  await run(['bun', 'run', 'build:app'], projectRoot);
  await run(['cf', 'build', '--mode', 'development']);
  const invocation = createDeployInvocation('dry-run', environment);
  await run([invocation.command, ...invocation.args]);
} else if (command === 'deploy' || command === 'pre') {
  const forwardedArgs = normalizeDeployArguments(args);
  readCloudflareTarget(process.env.FLAREMAIL_CF_CONFIG ?? (command === 'deploy' ? 'cloudflare.deploy.json' : 'cloudflare.preview.json'), true);
  const invocation = createDeployInvocation('deploy', environment, args);
  await run(command === 'deploy' ? [invocation.command, ...invocation.args] : ['cf', 'previews', 'deploy', '--mode', mode, ...forwardedArgs]);
} else throw new Error('Usage: bun scripts/cloudflare.ts <build|preview|typegen|migrate|dry-run|deploy|pre>');
