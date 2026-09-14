<script lang="ts">
  import { onMount } from 'svelte';
  import { Search, X } from '@lucide/svelte';
  import { IconButton } from '$lib/components/ui';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    query = '',
    placeholder,
    disabled = false,
    onQueryChange,
    id = 'mail-search'
  }: {
    query?: string;
    placeholder?: string;
    disabled?: boolean;
    id?: string;
    onQueryChange?: (query: string) => void;
  } = $props();

  let searchInput = $state<HTMLInputElement>();
  const { t } = useLocale();

  onMount(() => {
    const focusSearch = () => searchInput?.focus();
    window.addEventListener('flaremail:focus-search', focusSearch);
    return () => window.removeEventListener('flaremail:focus-search', focusSearch);
  });
</script>

<div class="relative min-w-0 flex-1">
  <label class="sr-only" for={id}>{t('mail.search')}</label>
  <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--fm-text-muted)]" aria-hidden="true" />
  <input
    bind:this={searchInput}
    {id}
    type="search"
    value={query}
    placeholder={placeholder ?? t('mail.searchPlaceholder')}
    {disabled}
    autocomplete="off"
    enterkeyhint="search"
    class="fm-field h-9 w-full pl-9 pr-10 text-sm"
    aria-label={t('mail.search')}
    aria-describedby={`${id}-hint`}
    oninput={(event) => onQueryChange?.(event.currentTarget.value)}
  />
  {#if query}
    <IconButton
      ariaLabel={t('mail.clearSearch')}
      title={t('mail.clearSearch')}
      size="sm"
      class="absolute right-1 top-1/2 size-11 -translate-y-1/2 sm:size-7"
      onclick={() => onQueryChange?.('')}
    >
      <X class="size-4" aria-hidden="true" />
    </IconButton>
  {/if}
  <span class="sr-only" id={`${id}-hint`}>{t('mail.searchPlaceholder')}</span>
</div>
