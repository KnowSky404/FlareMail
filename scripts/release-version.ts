import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function readCheckoutGit(root: string, args: string[]) {
  const gitDir = join(root, '.git');
  if (!existsSync(gitDir)) return null;
  const result = spawnSync('git', [`--git-dir=${gitDir}`, `--work-tree=${root}`, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function readReleaseVersion(root: string): string {
  const tags = readCheckoutGit(root, ['tag', '--no-column', '--merged', 'HEAD', '--list', 'v*']);
  const releaseTag = tags?.split('\n')
    .filter(tag => /^v(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/u.test(tag))
    .sort(compareReleaseTags)
    .at(-1);
  if (releaseTag) return releaseTag.slice(1);

  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  return version;
}

function compareReleaseTags(left: string, right: string): number {
  const leftParts = left.slice(1).split('.');
  const rightParts = right.slice(1).split('.');
  for (let index = 0; index < leftParts.length; index++) {
    const difference = BigInt(leftParts[index]) - BigInt(rightParts[index]);
    if (difference !== 0n) return difference < 0n ? -1 : 1;
  }
  return 0;
}

export function assertReleaseHistory(root: string): void {
  if (!existsSync(join(root, '.git'))) return;
  const shallow = readCheckoutGit(root, ['rev-parse', '--is-shallow-repository']);
  if (shallow === 'true') throw new Error('Fetch complete Git history and release tags with git fetch --unshallow --tags before deployment.');
  if (shallow !== 'false') throw new Error('Could not verify Git history for deployment.');
}
