import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_LOCALE,
  formatDate,
  formatNumber,
  formatRelativeTime,
  interpolate,
  messages,
  normalizeLocale,
  parseAcceptLanguage,
  parseLocale,
  createLocaleContext,
  translate,
  translateCount,
  type MessageKey
} from './index';
import {
  BROWSER_LOCALE_PREFERENCE,
  LOCALE_COOKIE_NAME,
  LOCALE_STORAGE_KEY,
  parseLocalePreference,
  readLocaleSelection,
  readLocalePreference,
  resolveLocale,
  writeLocalePreference
} from '$lib/client/locale-preferences';

describe('locale normalization and browser language parsing', () => {
  test('maps supported language tags and safely falls back for invalid input', () => {
    expect(parseLocale('en-US')).toBe('en');
    expect(parseLocale('zh')).toBe('zh-CN');
    expect(parseLocale('pt-BR')).toBeNull();
    expect(normalizeLocale('invalid')).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale(null, 'en')).toBe('en');
  });

  test('respects q weights and original order for Accept-Language', () => {
    expect(parseAcceptLanguage('fr-FR;q=0.9,en-US;q=0.8,zh-CN;q=1')).toBe('zh-CN');
    expect(parseAcceptLanguage('en-US,zh-CN;q=0.8')).toBe('en');
    expect(parseAcceptLanguage('fr-FR,de-DE;q=0.8')).toBe(DEFAULT_LOCALE);
    expect(parseAcceptLanguage('en;q=0')).toBe(DEFAULT_LOCALE);
  });
});

describe('message catalogs and formatters', () => {
  test('keeps both catalogs complete and interpolates typed message keys', () => {
    for (const key of Object.keys(messages['zh-CN']) as MessageKey[]) {
      expect(messages.en[key]).toBeString();
    }
    expect(translate('en', 'mail.messageCount', { count: 3 })).toBe('3 messages');
    expect(translate('zh-CN', 'mail.messageCount', { count: 3 })).toBe('3 封邮件');
    expect(translateCount('en', 'mail.messageCount', 1)).toBe('1 message');
    expect(translateCount('en', 'mail.messageCount', 2)).toBe('2 messages');
    expect(translateCount('zh-CN', 'mail.messageCount', 1)).toBe('1 封邮件');
    expect(interpolate('Hello, {name}!', { name: 'Ada' })).toBe('Hello, Ada!');
    expect(translate('en', 'missing.key' as MessageKey)).toBe('missing.key');
    expect(translate('invalid' as 'en', 'common.language')).toBe('语言');
  });

  test('formats numbers, dates and relative times by locale', () => {
    expect(formatNumber(1234567.89, 'en')).toBe('1,234,567.89');
    expect(formatDate('2026-09-14T12:34:56.000Z', 'en', {
      day: '2-digit',
      month: '2-digit',
      timeZone: 'UTC',
      year: 'numeric'
    })).toBe('09/14/2026');
    expect(formatRelativeTime('2026-09-14T12:29:56.000Z', 'en', '2026-09-14T12:34:56.000Z')).toBe('5 minutes ago');
    expect(formatDate('not-a-date', 'en')).toBe('');
  });
});

describe('locale context', () => {
  test('updates subscribers without coupling locale changes to navigation', () => {
    const context = createLocaleContext('en');
    const observed: string[] = [];
    const unsubscribe = context.subscribe((locale) => observed.push(locale));

    expect(context.setLocale('zh-CN')).toBe('zh-CN');
    unsubscribe();
    context.setLocale('en');
    expect(context.locale).toBe('en');
    expect(observed).toEqual(['zh-CN']);
  });
});

describe('locale preferences', () => {
  test('prioritizes the safe cookie, then localStorage, then Accept-Language', () => {
    const storage = new Map<string, string>();
    const storageLike = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value)
    };

    expect(resolveLocale({ cookie: 'flaremail-locale=en', storage: storageLike, acceptLanguage: 'zh-CN' })).toBe('en');
    expect(resolveLocale({ cookie: 'en', storage: storageLike, acceptLanguage: 'zh-CN' })).toBe('en');
    expect(resolveLocale({ cookie: 'flaremail-locale=invalid', storage: storageLike, acceptLanguage: 'zh-CN' })).toBe('zh-CN');
    storage.set(LOCALE_STORAGE_KEY, 'en');
    expect(readLocalePreference({ cookie: '', storage: storageLike, acceptLanguage: 'zh-CN' })).toBe('en');
    storage.set(LOCALE_STORAGE_KEY, 'invalid');
    expect(readLocalePreference({ cookie: '', storage: storageLike, acceptLanguage: 'zh-CN' })).toBe('zh-CN');
  });

  test('keeps browser-following as a persisted preference while resolving its effective locale', () => {
    const storage = new Map<string, string>();
    const storageLike = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value)
    };

    expect(readLocaleSelection({ cookie: 'flaremail-locale=browser', acceptLanguage: 'en-US' })).toBe(BROWSER_LOCALE_PREFERENCE);
    expect(resolveLocale({ cookie: 'flaremail-locale=browser', acceptLanguage: 'en-US' })).toBe('en');
    expect(resolveLocale({ cookie: 'flaremail-locale=browser', acceptLanguage: 'fr-FR' })).toBe('zh-CN');

    const documentLike = { cookie: '' };
    expect(writeLocalePreference(BROWSER_LOCALE_PREFERENCE, {
      document: documentLike,
      storage: storageLike,
      acceptLanguage: 'en-US'
    })).toBe('en');
    expect(storage.get(LOCALE_STORAGE_KEY)).toBe(BROWSER_LOCALE_PREFERENCE);
    expect(documentLike.cookie.startsWith(`${LOCALE_COOKIE_NAME}=browser;`)).toBe(true);
    expect(parseLocalePreference('browser')).toBe(BROWSER_LOCALE_PREFERENCE);
    expect(parseLocalePreference('javascript:alert(1)')).toBeNull();
  });

  test('writes only supported cookie and storage values and emits the safe locale', () => {
    const storage = new Map<string, string>();
    const storageLike = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value)
    };
    const documentLike = { cookie: '' };
    const dispatched: string[] = [];

    expect(writeLocalePreference('javascript:alert(1)', {
      document: documentLike,
      storage: storageLike,
      dispatch: (locale) => dispatched.push(locale)
    })).toBe(DEFAULT_LOCALE);
    expect(documentLike.cookie).toBe(`${LOCALE_COOKIE_NAME}=zh-CN; Path=/; Max-Age=31536000; SameSite=Lax`);
    expect(storage.get(LOCALE_STORAGE_KEY)).toBe('zh-CN');
    expect(dispatched).toEqual(['zh-CN']);

    writeLocalePreference('en', { document: documentLike, storage: storageLike, dispatch: (locale) => dispatched.push(locale) });
    expect(documentLike.cookie.startsWith(`${LOCALE_COOKIE_NAME}=en;`)).toBe(true);
    expect(dispatched.at(-1)).toBe('en');
  });
});
