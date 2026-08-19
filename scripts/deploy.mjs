import { spawn } from 'node:child_process';
import { createDeployInvocation, parseDeployMode, requireDeployConfig } from './deploy-command.ts';

const configPath = 'wrangler.deploy.toml';
try {
  const mode = parseDeployMode(process.argv[2]);
  requireDeployConfig(configPath);
  const invocation = createDeployInvocation(mode, { configPath });
  const child = spawn(invocation.command, invocation.args, {
    stdio: 'inherit',
    env: invocation.env
  });

  child.on('error', (error) => {
    console.error(`Unable to start Wrangler: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unable to prepare deployment.');
  process.exit(1);
}
