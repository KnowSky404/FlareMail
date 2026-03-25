import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const configPath = 'wrangler.deploy.toml';
const mode = process.argv[2] ?? 'deploy';

if (!existsSync(configPath)) {
  console.error(
    [
      `Missing ${configPath}.`,
      'Copy wrangler.deploy.toml.example to wrangler.deploy.toml and fill in your real Cloudflare bindings before deploying.'
    ].join('\n')
  );
  process.exit(1);
}

const args =
  mode === 'dry-run'
    ? ['x', 'wrangler', 'deploy', 'worker/index.ts', '--config', configPath, '--dry-run', '--outdir', '/tmp/flaremail-dry-run']
    : ['x', 'wrangler', 'deploy', 'worker/index.ts', '--config', configPath];

const child = spawn('bun', args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || '/tmp'
  }
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
