import { createLocalWranglerEnvironment } from './wrangler-environment';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: bun scripts/wrangler-local.ts <wrangler arguments...>');
  process.exit(1);
}

const child = Bun.spawn(['bun', 'x', 'wrangler', ...args], {
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
  env: createLocalWranglerEnvironment()
});

process.exit(await child.exited);
