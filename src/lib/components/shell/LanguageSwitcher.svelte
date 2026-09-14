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
    LOCALE_CHANGE_EVENT,
    resolveLocale,
    writeLocalePreference
  } from '$lib/client/locale-preferences';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    locale,
    disabled = false,
    class: className = '',
    onLocaleChange
  }: {
    locale?: Locale;
    disabled?: boolean;
    class?: string;
    onLocaleChange?: (locale: Locale) => void | Promise<void>;
  } = $props();

  const context = getLocaleContext();
  const { t } = useLocale();
  let selectedLocale = $state<Locale>(normalizeLocale(context?.getLocale?.() ?? DEFAULT_LOCALE));
  const visibleLocale = $derived(locale === undefined ? selectedLocale : normalizeLocale(locale));

  $effect(() => {
    if (locale !== undefined) selectedLocale = normalizeLocale(locale);
  });

  onMount(() => {
    if (locale === undefined && !context) selectedLocale = resolveLocale();
    const unsubscribe = context?.subscribe((nextLocale) => {
      if (locale === undefined) selectedLocale = nextLocale;
    });
    const syncLocaleChange = (event: Event) => {
      const nextLocale = (event as CustomEvent<{ locale?: unknown }>).detail?.locale;
      if (locale === undefined && !context && nextLocale !== undefined) {
        selectedLocale = normalizeLocale(nextLocale, selectedLocale);
      }
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, syncLocaleChange);
    return () => {
      unsubscribe?.();
      window.removeEventListener(LOCALE_CHANGE_EVENT, syncLocaleChange);
    };
  });

  async function changeLocale(event: Event) {
    const nextLocale = normalizeLocale((event.currentTarget as HTMLSelectElement).value, visibleLocale);
    selectedLocale = writeLocalePreference(nextLocale);
    context?.setLocale(selectedLocale);
    await onLocaleChange?.(selectedLocale);
  }
</script>

<label class={`language-switcher ${className}`.trim()}>
  <span class="visually-hidden">{t('shell.languageSwitcher')}</span>
  <select
    aria-label={t('shell.languageSwitcher')}
    disabled={disabled}
    value={visibleLocale}
    onchange={changeLocale}
  >
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
