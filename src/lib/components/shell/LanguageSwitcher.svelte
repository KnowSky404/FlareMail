<script lang="ts">
  import { onMount } from 'svelte';
  import Monitor from '@lucide/svelte/icons/monitor';
  import { nextRadioIndex } from '$lib/components/ui/radio-navigation';
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
    variant = 'select',
    disabled = false,
    class: className = '',
    onLocaleChange
  }: {
    locale?: Locale;
    preference?: LocalePreference;
    variant?: 'select' | 'segmented';
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
  const choices = [BROWSER_LOCALE_PREFERENCE, ...SUPPORTED_LOCALES] as const;

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

  async function changeLocale(value: string) {
    const nextPreference: LocalePreference = value === BROWSER_LOCALE_PREFERENCE
      ? BROWSER_LOCALE_PREFERENCE
      : normalizeLocale(value, visibleLocale);
    const nextLocale = writeLocalePreference(nextPreference);
    selectedPreference = nextPreference;
    selectedLocale = nextLocale;
    context?.setLocale(selectedLocale);
    await onLocaleChange?.(selectedLocale);
  }

  function handleRadioKeydown(event: KeyboardEvent) {
    if (disabled) return;
    const button = event.currentTarget as HTMLButtonElement;
    const buttons = [...button.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []];
    const index = nextRadioIndex(event.key, buttons.indexOf(button), buttons.length);
    if (index === null) return;
    event.preventDefault();
    event.stopPropagation();
    void changeLocale(choices[index]);
    buttons[index]?.focus({ preventScroll: true });
  }
</script>

{#if variant === 'segmented'}
  <div class={`language-switcher ${className}`.trim()} role="radiogroup" aria-label={t('shell.languageSwitcher')}>
    {#each choices as choice}
      <button
        class:active={visiblePreference === choice}
        type="button"
        role="radio"
        aria-checked={visiblePreference === choice}
        tabindex={visiblePreference === choice ? 0 : -1}
        {disabled}
        onclick={() => void changeLocale(choice)}
        onkeydown={handleRadioKeydown}
      >
        {#if choice === BROWSER_LOCALE_PREFERENCE}
          <Monitor class="size-4" aria-hidden="true" />
        {:else}
          <span class="language-symbol" aria-hidden="true">{choice === 'zh-CN' ? '中' : 'En'}</span>
        {/if}
        <span>{choice === BROWSER_LOCALE_PREFERENCE ? t('common.browser') : choice === 'zh-CN' ? t('common.zhCN') : t('common.en')}</span>
      </button>
    {/each}
  </div>
{:else}
  <label class={`language-switcher ${className}`.trim()}>
    <span class="visually-hidden">{t('shell.languageSwitcher')}</span>
    <select
      class="fm-touch-target"
      aria-label={t('shell.languageSwitcher')}
      disabled={disabled}
      value={visiblePreference}
      onchange={(event) => void changeLocale(event.currentTarget.value)}
    >
      <option value={BROWSER_LOCALE_PREFERENCE}>{t('common.browser')}</option>
      <option value={SUPPORTED_LOCALES[0]}>{t('common.zhCN')}</option>
      <option value={SUPPORTED_LOCALES[1]}>{t('common.en')}</option>
    </select>
  </label>
{/if}

<style>
  .language-switcher {
    display: inline-flex;
    align-items: center;
  }

  .language-symbol {
    display: inline-flex;
    height: 16px;
    align-items: center;
    font-size: 13px;
    font-weight: 650;
    line-height: 1;
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
