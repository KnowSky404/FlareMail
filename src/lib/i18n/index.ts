import { getContext, setContext } from 'svelte';
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  type Locale
} from './locale';
import {
  messages,
  type MessageKey,
  type MessageValues
} from './messages';

export * from './locale';
export * from './messages';

export type Translator = (key: MessageKey, values?: MessageValues) => string;

const interpolatePattern = /\{([a-zA-Z0-9_.-]+)\}/g;

export const interpolate = (template: string, values: MessageValues = {}): string =>
  template.replace(interpolatePattern, (match, key: string) => {
    const value = values[key];
    return value === undefined || value === null ? match : String(value);
  });

/** Translate a typed key, falling back to the default catalog if a runtime catalog is incomplete. */
export const translate = (
  locale: Locale,
  key: MessageKey,
  values?: MessageValues
): string => {
  const localized = messages[normalizeLocale(locale)][key];
  const fallback = messages[DEFAULT_LOCALE][key];
  return interpolate(localized || fallback || key, values);
};

export const createTranslator = (locale: Locale): Translator =>
  (key, values) => translate(normalizeLocale(locale), key, values);

export type DateInput = Date | number | string;

const toValidDate = (value: DateInput): Date | null => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const formatDate = (
  value: DateInput,
  locale: Locale,
  options: Intl.DateTimeFormatOptions = {}
): string => {
  const date = toValidDate(value);
  if (!date) return '';
  const resolvedOptions = Object.keys(options).length > 0 ? options : { dateStyle: 'medium' as const };
  return new Intl.DateTimeFormat(normalizeLocale(locale), resolvedOptions).format(date);
};

export const formatNumber = (
  value: number,
  locale: Locale,
  options: Intl.NumberFormatOptions = {}
): string => {
  if (!Number.isFinite(value)) return '';
  return new Intl.NumberFormat(normalizeLocale(locale), options).format(value);
};

const relativeUnits = [
  { unit: 'year' as const, seconds: 31_536_000 },
  { unit: 'month' as const, seconds: 2_592_000 },
  { unit: 'week' as const, seconds: 604_800 },
  { unit: 'day' as const, seconds: 86_400 },
  { unit: 'hour' as const, seconds: 3_600 },
  { unit: 'minute' as const, seconds: 60 },
  { unit: 'second' as const, seconds: 1 }
];

export const formatRelativeTime = (
  value: DateInput,
  locale: Locale,
  now: DateInput = new Date()
): string => {
  const date = toValidDate(value);
  const current = toValidDate(now);
  if (!date || !current) return '';

  const differenceInSeconds = (date.getTime() - current.getTime()) / 1000;
  const unit = relativeUnits.find(({ seconds }) => Math.abs(differenceInSeconds) >= seconds) ?? relativeUnits.at(-1)!;
  const amount = Math.round(differenceInSeconds / unit.seconds);
  return new Intl.RelativeTimeFormat(normalizeLocale(locale), { numeric: 'auto' }).format(amount, unit.unit);
};

export type LocaleListener = (locale: Locale) => void;

export type LocaleContext = {
  readonly locale: Locale;
  getLocale: () => Locale;
  setLocale: (locale: Locale) => Locale;
  subscribe: (listener: LocaleListener) => () => void;
};

export const LOCALE_CONTEXT_KEY = Symbol('flaremail.locale');

export const createLocaleContext = (initialLocale: Locale = DEFAULT_LOCALE): LocaleContext => {
  let currentLocale = normalizeLocale(initialLocale);
  const listeners = new Set<LocaleListener>();

  return {
    get locale() {
      return currentLocale;
    },
    getLocale: () => currentLocale,
    setLocale: (nextLocale) => {
      currentLocale = normalizeLocale(nextLocale);
      for (const listener of listeners) listener(currentLocale);
      return currentLocale;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
};

export const provideLocaleContext = (context: LocaleContext): LocaleContext => {
  setContext(LOCALE_CONTEXT_KEY, context);
  return context;
};

export const getLocaleContext = (): LocaleContext | undefined =>
  getContext<LocaleContext | undefined>(LOCALE_CONTEXT_KEY);
