import { describe, expect, test } from 'bun:test';
import { browserTestPlan, parseBrowserSuite } from './playwright-projects';

describe('Playwright project orchestration', () => {
  test('isolates every Chromium and WebKit project by port and state directory', () => {
    for (const suite of ['chromium', 'webkit'] as const) {
      const plan = browserTestPlan(suite);
      expect(plan).toHaveLength(3);
      expect(new Set(plan.map(({ port }) => port)).size).toBe(3);
      expect(new Set(plan.map(({ stateDirectory }) => stateDirectory)).size).toBe(3);
      expect(plan.every(({ project, stateDirectory }) => stateDirectory.endsWith(`/flaremail-e2e/${suite}/${project}/state`))).toBe(true);
    }
  });

  test('keeps accessibility on isolated Chromium mobile projects', () => {
    const plan = browserTestPlan('a11y');
    expect(plan.map(({ project }) => project)).toEqual(['mobile', 'narrow']);
    expect(plan.every(({ project, stateDirectory }) => stateDirectory.endsWith(`/flaremail-e2e/a11y/${project}/state`))).toBe(true);
    expect(plan.every(({ args }) => args.join(' ').includes('accessible'))).toBe(true);
  });

  test('rejects unknown suites before spawning a browser', () => {
    expect(parseBrowserSuite(['webkit'])).toBe('webkit');
    expect(() => parseBrowserSuite(['production'])).toThrow('Usage:');
    expect(() => parseBrowserSuite([])).toThrow('Usage:');
  });
});
