<script lang="ts">
  import { onMount } from 'svelte';
  import {
    DEFAULT_LOCALE,
    getLocaleContext,
    normalizeLocale,
    SUPPORTED_LOCALES,
    type Locale
  } from '$lib/i18n';
  import {
    BROWSER_LOCALE_PREFERENCE,
    LOCALE_CHANGE_EVENT,
    LOCALE_STORAGE_KEY,
    parseLocalePreference,
    readLocaleSelection,
    resolveBrowserLocale,
    resolveLocale,
    writeLocalePreference,
    type LocalePreference
  } from '$lib/client/locale-preferences';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    locale,
    preference,
    disabled = false,
    class: className = '',
    onLocaleChange
  }: {
    locale?: Locale;
    preference?: LocalePreference;
    disabled?: boolean;
    class?: string;
    onLocaleChange?: (locale: Locale) => void | Promise<void>;
  } = $props();

  const context = getLocaleContext();
  const { t } = useLocale();
  let selectedLocale = $state<Locale>(normalizeLocale(context?.getLocale?.() ?? DEFAULT_LOCALE));
  let selectedPreference = $state<LocalePreference>(normalizeLocale(context?.getLocale?.() ?? DEFAULT_LOCALE));
  const visibleLocale = $derived(locale === undefined ? selectedLocale : normalizeLocale(locale));
  const visiblePreference = $derived(preference === undefined ? selectedPreference : preference);

  $effect(() => {
    if (locale !== undefined) selectedLocale = normalizeLocale(locale);
    if (preference !== undefined) selectedPreference = preference;
  });

  onMount(() => {
    if (locale === undefined) {
      const nextLocale = resolveLocale();
      selectedLocale = nextLocale;
      selectedPreference = readLocaleSelection() ?? selectedLocale;
      if (context?.getLocale() !== nextLocale) context?.setLocale(nextLocale);
    }
    const unsubscribe = context?.subscribe((nextLocale) => {
      if (locale === undefined) selectedLocale = nextLocale;
    });
    const syncLocaleChange = (event: Event) => {
      const detail = (event as CustomEvent<{ locale?: unknown; preference?: unknown }>).detail;
      if (locale === undefined && detail?.locale !== undefined) {
        selectedLocale = normalizeLocale(detail.locale, selectedLocale);
      }
      if (preference === undefined && (detail?.preference === BROWSER_LOCALE_PREFERENCE || detail?.preference === 'en' || detail?.preference === 'zh-CN')) {
        selectedPreference = detail.preference;
      }
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, syncLocaleChange);
    const syncStoredLocale = (event: StorageEvent) => {
      if (event.key !== LOCALE_STORAGE_KEY) return;
      const nextPreference = parseLocalePreference(event.newValue);
      if (!nextPreference) return;
      const nextLocale = nextPreference === BROWSER_LOCALE_PREFERENCE
        ? resolveBrowserLocale()
        : nextPreference;
      if (locale === undefined) {
        selectedPreference = nextPreference;
        selectedLocale = nextLocale;
      }
      if (context?.getLocale() !== nextLocale) context?.setLocale(nextLocale);
    };
    window.addEventListener('storage', syncStoredLocale);
    return () => {
      unsubscribe?.();
      window.removeEventListener(LOCALE_CHANGE_EVENT, syncLocaleChange);
      window.removeEventListener('storage', syncStoredLocale);
    };
  });

  async function changeLocale(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    const nextPreference: LocalePreference = value === BROWSER_LOCALE_PREFERENCE
      ? BROWSER_LOCALE_PREFERENCE
      : normalizeLocale(value, visibleLocale);
    const nextLocale = writeLocalePreference(nextPreference);
    selectedPreference = nextPreference;
    selectedLocale = nextLocale;
    context?.setLocale(selectedLocale);
    await onLocaleChange?.(selectedLocale);
  }
</script>

<label class={`language-switcher ${className}`.trim()}>
  <span class="visually-hidden">{t('shell.languageSwitcher')}</span>
  <select
    class="fm-touch-target"
    aria-label={t('shell.languageSwitcher')}
    disabled={disabled}
    value={visiblePreference}
    onchange={changeLocale}
  >
    <option value={BROWSER_LOCALE_PREFERENCE}>{t('common.browser')}</option>
    <option value={SUPPORTED_LOCALES[0]}>{t('common.zhCN')}</option>
    <option value={SUPPORTED_LOCALES[1]}>{t('common.en')}</option>
  </select>
</label>

<style>
  .language-switcher {
    display: inline-flex;
    align-items: center;
  }

  select {
    min-height: var(--control-default, 36px);
    padding: 0 28px 0 10px;
    border: 1px solid var(--fm-border, #d9dee8);
    border-radius: var(--radius-md, 8px);
    color: var(--fm-text-secondary, #475467);
    background: var(--fm-surface, #fff);
    cursor: pointer;
    font: inherit;
  }

  select:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
</style>
