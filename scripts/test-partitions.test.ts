import { describe, expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const partitionNames = ['test:unit', 'test:integration', 'test:remaining'] as const;

function portable(path: string) {
  return path.split(sep).join('/');
}

function commandTargets(command: string) {
  const tokens = [...command.matchAll(/'([^']+)'|"([^"]+)"|(\S+)/gu)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '');
  const testIndex = tokens.findIndex((token) => token === 'test');
  return tokens.slice(testIndex + 1).filter((token) => token && !token.startsWith('-'));
}

async function testFilesForTarget(target: string) {
  const absolute = join(root, target);
  const metadata = await stat(absolute);
  if (metadata.isFile()) return [portable(relative(root, absolute))];
  const files: string[] = [];
  for await (const file of new Bun.Glob('**/*.test.ts').scan({ cwd: absolute, onlyFiles: true })) {
    files.push(portable(join(target, file)));
  }
  return files;
}

async function allRepositoryTests() {
  const files: string[] = [];
  for (const directory of ['src', 'scripts']) {
    for await (const file of new Bun.Glob('**/*.test.ts').scan({ cwd: join(root, directory), onlyFiles: true })) {
      files.push(portable(join(directory, file)));
    }
  }
  return files.sort();
}

describe('Bun test partitions', () => {
  test('cover every repository test exactly once', async () => {
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const memberships = new Map<string, string[]>();
    for (const name of partitionNames) {
      for (const target of commandTargets(packageJson.scripts[name] ?? '')) {
        for (const file of await testFilesForTarget(target)) {
          memberships.set(file, [...(memberships.get(file) ?? []), name]);
        }
      }
    }

    const expected = await allRepositoryTests();
    expect([...memberships.keys()].sort()).toEqual(expected);
    expect([...memberships.entries()].filter(([, groups]) => groups.length !== 1)).toEqual([]);
  });
});
