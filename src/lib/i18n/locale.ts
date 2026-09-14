export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'zh-CN';

const normalizeLanguageTag = (value: string): string => value.trim().replaceAll('_', '-').toLowerCase();

export const isSupportedLocale = (value: unknown): value is Locale =>
  value === 'zh-CN' || value === 'en';

/** Return a supported locale for a locale tag, or null when the tag is unsupported. */
export const parseLocale = (value: unknown): Locale | null => {
  if (typeof value !== 'string') return null;

  const tag = normalizeLanguageTag(value);
  if (tag === 'en' || tag.startsWith('en-')) return 'en';
  if (tag === 'zh' || tag.startsWith('zh-')) return 'zh-CN';
  return null;
};

/** Normalize untrusted input without ever returning an unsupported locale. */
export const normalizeLocale = (value: unknown, fallback: Locale = DEFAULT_LOCALE): Locale =>
  parseLocale(value) ?? fallback;
type AcceptLanguageCandidate = {
  tag: string;
  quality: number;
  order: number;
};

const parseQuality = (value: string | undefined): number => {
  if (!value) return 1;
  const quality = Number(value.trim().replace(/^q=/i, ''));
  return Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0;
};

/** Resolve the highest-priority supported language from an Accept-Language value. */
export const parseAcceptLanguage = (
  header: string | null | undefined,
  fallback: Locale = DEFAULT_LOCALE
): Locale => {
  if (typeof header !== 'string' || header.trim() === '') return fallback;

  const candidates: AcceptLanguageCandidate[] = header
    .split(',')
    .map((part, order) => {
      const [tag, ...parameters] = part.split(';');
      const qualityParameter = parameters.find((parameter) => /^\s*q=/i.test(parameter));
      return { tag: tag.trim(), quality: parseQuality(qualityParameter), order };
    })
    .filter(({ tag, quality }) => tag !== '*' && quality > 0)
    .sort((left, right) => right.quality - left.quality || left.order - right.order);

  for (const candidate of candidates) {
    const locale = parseLocale(candidate.tag);
    if (locale) return locale;
  }

  return fallback;
};
