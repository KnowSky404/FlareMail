import { join } from 'node:path';
import { tmpdir } from 'node:os';

export type BrowserSuite = 'chromium' | 'webkit' | 'a11y';

export type BrowserProjectRun = {
  project: 'desktop' | 'mobile' | 'narrow' | 'webkit-desktop' | 'webkit-iphone' | 'webkit-ipad';
  port: number;
  stateDirectory: string;
  args: string[];
};

const accessibilityGrep = 'horizontal overflow|touch targets|accessible';

export function browserTestPlan(suite: BrowserSuite): BrowserProjectRun[] {
  const definitions = suite === 'chromium'
    ? [['desktop', 4173], ['mobile', 4174], ['narrow', 4175]] as const
    : suite === 'webkit'
      ? [['webkit-desktop', 4180], ['webkit-iphone', 4181], ['webkit-ipad', 4182]] as const
      : [['mobile', 4192], ['narrow', 4191]] as const;
  return definitions.map(([project, port]) => ({
    project,
    port,
    stateDirectory: join(tmpdir(), 'flaremail-e2e', suite, project, 'state'),
    args: suite === 'a11y' ? ['--grep', accessibilityGrep] : []
  }));
}

export function parseBrowserSuite(args: string[]): BrowserSuite {
  if (args.length !== 1 || !['chromium', 'webkit', 'a11y'].includes(args[0] ?? '')) {
    throw new Error('Usage: bun scripts/playwright-projects.ts chromium|webkit|a11y');
  }
  return args[0] as BrowserSuite;
}

export async function runBrowserSuite(suite: BrowserSuite) {
  const failures: Array<{ project: string; exitCode: number }> = [];
  for (const run of browserTestPlan(suite)) {
    console.log(JSON.stringify({
      event: 'browser_project_started',
      suite,
      project: run.project,
      port: run.port,
      isolatedState: true
    }));
    const child = Bun.spawn([
      'bunx', 'playwright', 'test', `--project=${run.project}`, ...run.args
    ], {
      stdout: 'inherit',
      stderr: 'inherit',
      env: {
        ...process.env,
        FLAREMAIL_E2E_PROJECT: run.project,
        FLAREMAIL_E2E_PORT: String(run.port),
        FLAREMAIL_E2E_STATE_DIR: run.stateDirectory
      }
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) failures.push({ project: run.project, exitCode });
  }
  if (failures.length > 0) {
    console.error(JSON.stringify({ event: 'browser_suite_failed', suite, failures }));
    return 1;
  }
  console.log(JSON.stringify({ event: 'browser_suite_completed', suite, projects: browserTestPlan(suite).length }));
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await runBrowserSuite(parseBrowserSuite(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Browser suite failed.');
    process.exitCode = 1;
  }
}
