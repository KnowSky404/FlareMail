export type DisplayDensity = 'comfortable' | 'compact';

export type LayoutPreferences = {
  version: 1;
  sidebarCollapsed: boolean;
  listWidth: number;
  density: DisplayDensity;
};

export const LAYOUT_PREFERENCES_KEY = 'flaremail-layout-v1';
export const DEFAULT_LAYOUT_PREFERENCES: LayoutPreferences = {
  version: 1,
  sidebarCollapsed: false,
  listWidth: 360,
  density: 'comfortable'
};

const MIN_LIST_WIDTH = 280;
const MAX_LIST_WIDTH = 480;
const SPLITTER_WIDTH = 8;
const MIN_DETAIL_WIDTH = 360;

export function clampListWidth(value: number, availableWidth = Number.POSITIVE_INFINITY) {
  const parsed = Number.isFinite(value) ? Math.round(value) : DEFAULT_LAYOUT_PREFERENCES.listWidth;
  const upperBound = Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, Math.floor(availableWidth - MIN_DETAIL_WIDTH - SPLITTER_WIDTH)));
  return Math.min(upperBound, Math.max(MIN_LIST_WIDTH, parsed));
}

export function listWidthFromKeyboard(
  current: number,
  key: string,
  availableWidth = Number.POSITIVE_INFINITY
): number | null {
  const currentWidth = clampListWidth(current, availableWidth);
  if (key === 'ArrowLeft') return clampListWidth(currentWidth - 16, availableWidth);
  if (key === 'ArrowRight') return clampListWidth(currentWidth + 16, availableWidth);
  if (key === 'Home') return clampListWidth(MIN_LIST_WIDTH, availableWidth);
  if (key === 'End') return clampListWidth(MAX_LIST_WIDTH, availableWidth);
  if (key === 'Enter') return clampListWidth(DEFAULT_LAYOUT_PREFERENCES.listWidth, availableWidth);
  return null;
}

export function normalizeLayoutPreferences(value: unknown): LayoutPreferences {
  if (!value || typeof value !== 'object') return { ...DEFAULT_LAYOUT_PREFERENCES };
  const input = value as Partial<LayoutPreferences>;
  return {
    version: 1,
    sidebarCollapsed: input.sidebarCollapsed === true,
    listWidth: clampListWidth(typeof input.listWidth === 'number' ? input.listWidth : DEFAULT_LAYOUT_PREFERENCES.listWidth),
    density: input.density === 'compact' ? 'compact' : 'comfortable'
  };
}

export function readLayoutPreferences(storage?: Storage): LayoutPreferences {
  if (!storage) return { ...DEFAULT_LAYOUT_PREFERENCES };
  try {
    const raw = storage.getItem(LAYOUT_PREFERENCES_KEY);
    return raw ? normalizeLayoutPreferences(JSON.parse(raw)) : { ...DEFAULT_LAYOUT_PREFERENCES };
  } catch {
    return { ...DEFAULT_LAYOUT_PREFERENCES };
  }
}

export function writeLayoutPreferences(preferences: LayoutPreferences, storage?: Storage) {
  if (!storage) return;
  try {
    storage.setItem(LAYOUT_PREFERENCES_KEY, JSON.stringify(normalizeLayoutPreferences(preferences)));
  } catch {
    // Private browsing and disabled storage are supported as an in-memory fallback.
  }
}

export function layoutPreferenceRange() {
  return { min: MIN_LIST_WIDTH, max: MAX_LIST_WIDTH } as const;
}
