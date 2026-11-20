import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertReleaseHistory, readReleaseVersion } from './release-version';
import { inspectGit } from './release-preflight';

test('uses the highest stable release reachable from the build commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flaremail-release-tags-'));
  const env = { ...process.env };
  for (const name of execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).trim().split('\n')) {
    delete env[name];
  }
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false',
    '-c', 'user.name=FlareMail Test', '-c', 'user.email=release-test@example.invalid', ...args
  ], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  try {
    const packageVersion = '1.0.0';
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: packageVersion }));
    git('init', '--quiet');
    git('commit', '--allow-empty', '-qm', 'first release');
    expect(readReleaseVersion(root)).toBe(packageVersion);
    git('tag', 'v1.9.0');
    const older = git('rev-parse', 'HEAD');
    git('commit', '--allow-empty', '-qm', 'next release');
    git('tag', '-a', 'v1.10.0', '-m', 'second release');
    git('tag', 'v2.0.0-rc.1');
    git('tag', 'v2.01.0');
    git('commit', '--allow-empty', '-qm', 'follow-up change');
    git('config', 'column.tag', 'always');
    git('config', 'versionsort.suffix', '.10');
    git('config', 'tag.sort', 'unsupported-sort-field');
    expect(readReleaseVersion(root)).toBe('1.10.0');

    const shallow = join(root, 'shallow');
    git('clone', '--quiet', '--no-local', '--depth=1', root, shallow);
    expect(() => assertReleaseHistory(shallow)).toThrow('git fetch --unshallow --tags');
    expect((await inspectGit(shallow)).historyError).toContain('git fetch --unshallow --tags');
    expect(() => assertReleaseHistory(root)).not.toThrow();

    git('checkout', '--quiet', '--detach', older);
    expect(readReleaseVersion(root)).toBe('1.9.0');

    git('symbolic-ref', 'HEAD', 'refs/heads/no-commits');
    expect(() => readReleaseVersion(root)).toThrow('Could not read Git release metadata.');

    const archive = join(root, 'source-archive');
    mkdirSync(archive);
    writeFileSync(join(archive, 'package.json'), JSON.stringify({ version: packageVersion }));
    expect(readReleaseVersion(archive)).toBe(packageVersion);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
