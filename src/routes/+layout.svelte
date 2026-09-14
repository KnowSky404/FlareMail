<script lang="ts">
  import { onMount } from 'svelte';
  import '../app.css';
  import { createLocaleContext, provideLocaleContext, type Locale } from '$lib/i18n';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();
  let activeLocale = $state<Locale>('zh-CN');
  const initialLocale = $derived(data.locale);
  // svelte-ignore state_referenced_locally
  const localeContext = createLocaleContext(initialLocale);
  activeLocale = localeContext.getLocale();
  const originalSetLocale = localeContext.setLocale;
  localeContext.setLocale = (locale) => {
    const next = originalSetLocale(locale);
    activeLocale = next;
    return next;
  };
  provideLocaleContext(localeContext);

  $effect(() => {
    activeLocale;
    if (typeof document !== 'undefined') document.documentElement.lang = activeLocale;
  });

  onMount(() => {
    const syncLocale = (event: Event) => {
      const next = (event as CustomEvent<{ locale?: Locale }>).detail?.locale;
      if (next) localeContext.setLocale(next);
    };
    window.addEventListener('flaremail:locale-change', syncLocale);
    return () => window.removeEventListener('flaremail:locale-change', syncLocale);
  });
</script>

{@render children()}
