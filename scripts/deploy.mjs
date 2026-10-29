// Retained for operators using the previous script path.
import { spawn } from 'node:child_process';
import { parseDeployMode } from './deploy-command.ts';
const child = spawn('bun', ['scripts/cloudflare.ts', parseDeployMode(process.argv[2])], { stdio: 'inherit' });
child.on('error', (error) => { console.error(error.message); process.exit(1); });
child.on('exit', (code) => process.exit(code ?? 1));
