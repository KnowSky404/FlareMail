import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  normalizeLocale,
  parseAcceptLanguage,
  parseLocale,
  type Locale
} from '$lib/i18n/locale';

export const LOCALE_STORAGE_KEY = 'flaremail-locale';
export const LOCALE_COOKIE_NAME = 'flaremail-locale';
export const LOCALE_CHANGE_EVENT = 'flaremail:locale-change';
export const LOCALE_COOKIE_MAX_AGE = 31_536_000;
export const BROWSER_LOCALE_PREFERENCE = 'browser' as const;

export type LocalePreference = Locale | typeof BROWSER_LOCALE_PREFERENCE;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type DocumentLike = Pick<Document, 'cookie'>;

export type LocalePreferenceEnvironment = {
  cookie?: string | null;
  storage?: StorageLike | null;
  acceptLanguage?: string | null;
  document?: DocumentLike | null;
  dispatch?: (locale: Locale, preference: LocalePreference) => void;
};

const getBrowserStorage = (): StorageLike | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const getBrowserDocument = (): DocumentLike | null =>
  typeof document === 'undefined' ? null : document;

export const readCookie = (cookie: string | null | undefined, name = LOCALE_COOKIE_NAME): string | null => {
  if (!cookie) return null;
  const directValue = cookie.trim();
  if (isSupportedLocale(directValue) || directValue === BROWSER_LOCALE_PREFERENCE) return directValue;
  const prefix = `${name}=`;
  const entry = directValue.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!entry) return null;
  const value = entry.slice(prefix.length);
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

export const parseLocalePreference = (value: unknown): LocalePreference | null => {
  if (isSupportedLocale(value) || value === BROWSER_LOCALE_PREFERENCE) return value;
  return null;
};

const browserAcceptLanguage = (): string | null => {
  if (typeof navigator === 'undefined') return null;
  const languages = Array.isArray(navigator.languages) ? navigator.languages : [];
  return [...languages, navigator.language].filter(Boolean).join(',');
};

/** Read the persisted selection, using browser language only when no selection exists. */
export const readLocaleSelection = (
  environment: LocalePreferenceEnvironment = {}
): LocalePreference | null => {
  const documentValue = environment.document ?? getBrowserDocument();
  const cookie = environment.cookie === undefined ? documentValue?.cookie : environment.cookie;
  const cookiePreference = parseLocalePreference(readCookie(cookie));
  if (cookiePreference) return cookiePreference;

  const storage = environment.storage === undefined ? getBrowserStorage() : environment.storage;
  let storedValue: string | null = null;
  try {
    storedValue = storage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    storedValue = null;
  }
  const storedPreference = parseLocalePreference(storedValue);
  if (storedPreference) return storedPreference;

  const acceptLanguage = environment.acceptLanguage === undefined
    ? browserAcceptLanguage()
    : environment.acceptLanguage;
  if (!acceptLanguage) return null;
  const hasSupportedCandidate = acceptLanguage.split(',').some((part) => {
    const [tag, ...parameters] = part.split(';');
    const qualityParameter = parameters.find((parameter) => /^\s*q=/i.test(parameter));
    const quality = qualityParameter ? Number(qualityParameter.trim().slice(2)) : 1;
    return quality > 0 && parseLocale(tag.trim()) !== null;
  });
  return hasSupportedCandidate ? BROWSER_LOCALE_PREFERENCE : null;
};

export const resolveBrowserLocale = (
  environment: LocalePreferenceEnvironment = {},
  fallback: Locale = DEFAULT_LOCALE
): Locale => {
  const acceptLanguage = environment.acceptLanguage === undefined
    ? browserAcceptLanguage()
    : environment.acceptLanguage;
  return parseAcceptLanguage(acceptLanguage, fallback);
};

/** Resolve the effective locale while keeping browser-following distinct from an explicit choice. */
export const readLocalePreference = (
  environment: LocalePreferenceEnvironment = {}
): Locale | null => {
  const selection = readLocaleSelection(environment);
  if (!selection) return null;
  return selection === BROWSER_LOCALE_PREFERENCE ? resolveBrowserLocale(environment) : selection;
};

export const resolveLocale = (
  environment: LocalePreferenceEnvironment = {},
  fallback: Locale = DEFAULT_LOCALE
): Locale => {
  const selection = readLocaleSelection(environment);
  if (!selection) return normalizeLocale(fallback);
  return selection === BROWSER_LOCALE_PREFERENCE
    ? resolveBrowserLocale(environment, fallback)
    : selection;
};

const defaultDispatch = (locale: Locale, preference: LocalePreference): void => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(LOCALE_CHANGE_EVENT, { detail: { locale, preference } }));
  }
};

/** Persist a safe locale selection and notify same-page consumers without navigating. */
export const writeLocalePreference = (
  value: unknown,
  environment: LocalePreferenceEnvironment = {}
): Locale => {
  const preference: LocalePreference = value === BROWSER_LOCALE_PREFERENCE
    ? BROWSER_LOCALE_PREFERENCE
    : normalizeLocale(value);
  const locale = preference === BROWSER_LOCALE_PREFERENCE
    ? resolveBrowserLocale(environment)
    : preference;
  const storage = environment.storage === undefined ? getBrowserStorage() : environment.storage;
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, preference);
  } catch {
    // The cookie and in-memory change remain useful when storage is unavailable.
  }

  const documentValue = environment.document ?? getBrowserDocument();
  if (documentValue) {
    const secure = typeof location !== 'undefined' && location.protocol === 'https:';
    documentValue.cookie = `${LOCALE_COOKIE_NAME}=${preference}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${secure ? '; Secure' : ''}`;
  }

  (environment.dispatch ?? defaultDispatch)(locale, preference);
  return locale;
};

export const setLocalePreference = writeLocalePreference;
