import { browser } from '$app/environment';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'flaremail-theme';

const isThemePreference = (value: string | null): value is ThemePreference =>
  value === 'light' || value === 'dark' || value === 'system';

export const readThemePreference = (): ThemePreference => {
  if (!browser) {
    return 'system';
  }

  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : 'system';
  } catch {
    return 'system';
  }
};

export const resolveTheme = (
  preference: ThemePreference,
  prefersDark = browser && matchMedia('(prefers-color-scheme: dark)').matches
): ResolvedTheme => (preference === 'system' ? (prefersDark ? 'dark' : 'light') : preference);

export const applyTheme = (preference: ThemePreference): ResolvedTheme => {
  const resolved = resolveTheme(preference);

  if (browser) {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Theme remains applied for this tab when persistence is unavailable.
    }
    window.dispatchEvent(
      new CustomEvent('flaremail:theme-change', { detail: { preference, resolved } })
    );
  }

  return resolved;
};

export const nextThemePreference = (preference: ThemePreference): ThemePreference =>
  preference === 'system' ? 'light' : preference === 'light' ? 'dark' : 'system';
