import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_LAYOUT_PREFERENCES,
  clampListWidth,
  normalizeLayoutPreferences,
  readLayoutPreferences,
  writeLayoutPreferences
} from './layout-preferences';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  } as unknown as Storage;
}

describe('layout preferences', () => {
  test('normalizes corrupt and legacy values without throwing', () => {
    expect(normalizeLayoutPreferences({ sidebarCollapsed: 'yes', listWidth: 9999, density: 'unknown' })).toEqual({
      ...DEFAULT_LAYOUT_PREFERENCES,
      listWidth: 480
    });
    expect(readLayoutPreferences(memoryStorage())).toEqual(DEFAULT_LAYOUT_PREFERENCES);
  });

  test('clamps list width against the available content width', () => {
    expect(clampListWidth(200)).toBe(280);
    expect(clampListWidth(480, 600)).toBe(280);
    expect(clampListWidth(420, 900)).toBe(420);
  });

  test('round trips versioned values through storage', () => {
    const storage = memoryStorage();
    writeLayoutPreferences({ version: 1, sidebarCollapsed: true, listWidth: 414, density: 'compact' }, storage);
    expect(readLayoutPreferences(storage)).toEqual({ version: 1, sidebarCollapsed: true, listWidth: 414, density: 'compact' });
  });
});
