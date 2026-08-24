import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const requestedProject = process.env.FLAREMAIL_E2E_PROJECT;
const port = Number(process.env.FLAREMAIL_E2E_PORT ?? 4173);
const stateDirectory = process.env.FLAREMAIL_E2E_STATE_DIR ?? join(
  tmpdir(),
  'flaremail-e2e',
  requestedProject ?? 'default',
  'state'
);
const baseURL = `http://127.0.0.1:${port}`;
const chromiumLaunchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : undefined;
const webkitLaunchOptions = process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH }
  : undefined;
const chromiumTestMatch = /workspace\.spec\.ts/u;
const webkitSmokeTestMatch = /webkit-smoke\.spec\.ts/u;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: join('test-results', requestedProject ?? 'all'),
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: join('playwright-report', requestedProject ?? 'all'), open: 'never' }]
  ],
  use: {
    baseURL,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  webServer: {
    command: `bun scripts/e2e/start-local.ts --port ${port}`,
    env: { FLAREMAIL_E2E_STATE_DIR: stateDirectory },
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe'
  },
  projects: [
    {
      name: 'desktop',
      testMatch: chromiumTestMatch,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        launchOptions: chromiumLaunchOptions
      }
    },
    {
      name: 'mobile',
      testMatch: chromiumTestMatch,
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        launchOptions: chromiumLaunchOptions
      }
    },
    {
      name: 'narrow',
      testMatch: chromiumTestMatch,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 320, height: 720 },
        launchOptions: chromiumLaunchOptions
      }
    },
    {
      name: 'webkit-desktop',
      testMatch: webkitSmokeTestMatch,
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1280, height: 900 },
        launchOptions: webkitLaunchOptions
      }
    },
    {
      name: 'webkit-iphone',
      testMatch: webkitSmokeTestMatch,
      use: {
        ...devices['iPhone 13'],
        launchOptions: webkitLaunchOptions
      }
    },
    {
      name: 'webkit-ipad',
      testMatch: webkitSmokeTestMatch,
      use: {
        ...devices['iPad (gen 7)'],
        launchOptions: webkitLaunchOptions
      }
    }
  ].filter((project) => !requestedProject || project.name === requestedProject)
});
