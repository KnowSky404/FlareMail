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

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type DocumentLike = Pick<Document, 'cookie'>;

export type LocalePreferenceEnvironment = {
  cookie?: string | null;
  storage?: StorageLike | null;
  acceptLanguage?: string | null;
  document?: DocumentLike | null;
  dispatch?: (locale: Locale) => void;
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
  if (isSupportedLocale(directValue)) return directValue;
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

const readExactStoredLocale = (value: string | null | undefined): Locale | null => {
  if (isSupportedLocale(value)) return value;
  return null;
};

const browserAcceptLanguage = (): string | null => {
  if (typeof navigator === 'undefined') return null;
  const languages = Array.isArray(navigator.languages) ? navigator.languages : [];
  return [...languages, navigator.language].filter(Boolean).join(',');
};

/** Read explicit cookie/localStorage preference, then the browser language preference. */
export const readLocalePreference = (
  environment: LocalePreferenceEnvironment = {}
): Locale | null => {
  const documentValue = environment.document ?? getBrowserDocument();
  const cookie = environment.cookie === undefined ? documentValue?.cookie : environment.cookie;
  const cookieLocale = readExactStoredLocale(readCookie(cookie));
  if (cookieLocale) return cookieLocale;

  const storage = environment.storage === undefined ? getBrowserStorage() : environment.storage;
  let storedValue: string | null = null;
  try {
    storedValue = storage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    storedValue = null;
  }
  const storedLocale = readExactStoredLocale(storedValue);
  if (storedLocale) return storedLocale;

  const acceptLanguage = environment.acceptLanguage === undefined
    ? browserAcceptLanguage()
    : environment.acceptLanguage;
  if (!acceptLanguage) return null;
  const browserLocale = parseAcceptLanguage(acceptLanguage, DEFAULT_LOCALE);
  const hasSupportedCandidate = acceptLanguage.split(',').some((part) => {
    const [tag, ...parameters] = part.split(';');
    const qualityParameter = parameters.find((parameter) => /^\s*q=/i.test(parameter));
    const quality = qualityParameter ? Number(qualityParameter.trim().slice(2)) : 1;
    return quality > 0 && parseLocale(tag.trim()) !== null;
  });
  return hasSupportedCandidate ? browserLocale : null;
};

export const resolveLocale = (
  environment: LocalePreferenceEnvironment = {},
  fallback: Locale = DEFAULT_LOCALE
): Locale => readLocalePreference(environment) ?? normalizeLocale(fallback);

const defaultDispatch = (locale: Locale): void => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(LOCALE_CHANGE_EVENT, { detail: { locale } }));
  }
};

/** Persist only a supported locale and notify same-page consumers without navigating. */
export const writeLocalePreference = (
  value: unknown,
  environment: LocalePreferenceEnvironment = {}
): Locale => {
  const locale = normalizeLocale(value);
  const storage = environment.storage === undefined ? getBrowserStorage() : environment.storage;
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // The cookie and in-memory change remain useful when storage is unavailable.
  }

  const documentValue = environment.document ?? getBrowserDocument();
  if (documentValue) {
    const secure = typeof location !== 'undefined' && location.protocol === 'https:';
    documentValue.cookie = `${LOCALE_COOKIE_NAME}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${secure ? '; Secure' : ''}`;
  }

  (environment.dispatch ?? defaultDispatch)(locale);
  return locale;
};

export const setLocalePreference = writeLocalePreference;
