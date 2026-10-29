import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRoot } from './cloudflare-target';

async function runMigration(remote: boolean, args: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'flaremail-migrate-regression-'));
  const capture = join(directory, 'arguments');
  const mutation = join(directory, 'mutation');
  try {
    const config = JSON.parse(await readFile(join(projectRoot, 'cloudflare.local.json'), 'utf8'));
    config.databaseId = '12345678-1234-4234-8234-123456789abc';
    config.bucket = 'migration-regression';
    config.vars.APP_ENV = remote ? 'production' : 'development';
    const target = join(directory, 'target.json');
    await writeFile(target, JSON.stringify(config));
    // This CLI records arguments and simulates a write; it never contacts D1.
    const cli = join(directory, 'cf');
    await writeFile(cli, `#!/bin/sh
printf '%s\\n' "$@" > "$FLAREMAIL_TEST_CAPTURE"
for argument in "$@"; do
  if [ "$argument" = '--dry-run' ]; then exit 0; fi
done
touch "$FLAREMAIL_TEST_MUTATION"
`);
    await chmod(cli, 0o700);
    const child = Bun.spawn([
      process.execPath, 'run', remote ? 'db:migrate:remote' : 'db:migrate:local', '--', ...args
    ], {
      cwd: projectRoot,
      env: {
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        FLAREMAIL_CF_CONFIG: target,
        FLAREMAIL_STATE_DIR: join(directory, 'state'),
        FLAREMAIL_TEST_CAPTURE: capture,
        FLAREMAIL_TEST_MUTATION: mutation
      },
      stdout: 'pipe', stderr: 'pipe'
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    return {
      code, stderr,
      args: await Bun.file(capture).exists() ? (await readFile(capture, 'utf8')).trim().split('\n') : null,
      mutated: await Bun.file(mutation).exists(),
      state: join(directory, 'state')
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('remote migration script preserves dry-run and does not execute the simulated write', async () => {
  const result = await runMigration(true, ['--dry-run']);
  expect(result.code).toBe(0);
  expect(result.args).toContain('--dry-run');
  expect(result.args).not.toContain('--local');
  expect(result.mutated).toBe(false);
});

test('local migration dry-run retains the isolated local state', async () => {
  const result = await runMigration(false, ['--dry-run']);
  expect(result.code).toBe(0);
  expect(result.args).toContain('--dry-run');
  expect(result.args).toContain('--local');
  expect(result.args?.slice(-2)).toEqual(['--persist-to', result.state]);
  expect(result.mutated).toBe(false);
});

test('unknown remote migration options fail before invoking the CLI', async () => {
  const result = await runMigration(true, ['--typo-dry-run']);
  expect(result.code).not.toBe(0);
  expect(result.args).toBeNull();
  expect(result.mutated).toBe(false);
});
