<script lang="ts">
  import { Inbox, SearchX, Star } from '@lucide/svelte';
  import { Button } from '$lib/components/ui';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    title,
    description,
    searchActive = false,
    filterActive = false,
    onClear,
    onRefresh
  }: {
    title?: string;
    description?: string;
    searchActive?: boolean;
    filterActive?: boolean;
    onClear?: () => void;
    onRefresh?: () => void | Promise<void>;
  } = $props();
  const { t } = useLocale();
  const heading = $derived(title ?? t('mail.noMail'));
  const copy = $derived(description ?? t('mail.newMailHint'));

  const iconKind = $derived(searchActive ? 'search' : filterActive ? 'starred' : 'inbox');
</script>

<div class="grid min-h-56 place-items-center px-6 py-10 text-center" role="status">
  <div class="grid max-w-sm justify-items-center">
    <div class="mb-3 grid size-11 place-items-center rounded-full bg-[var(--fm-surface-subtle)] text-[var(--fm-text-muted)]">
      {#if iconKind === 'search'}
        <SearchX class="size-5" aria-hidden="true" />
      {:else if iconKind === 'starred'}
        <Star class="size-5" aria-hidden="true" />
      {:else}
        <Inbox class="size-5" aria-hidden="true" />
      {/if}
    </div>
    <h2 class="text-sm font-semibold text-[var(--fm-text)]">{heading}</h2>
    <p class="mt-1 text-xs leading-5 text-[var(--fm-text-muted)]">{copy}</p>
    {#if searchActive || filterActive}
      <Button variant="secondary" size="sm" class="mt-4" onclick={() => onClear?.()}>{t('mail.clearSearchAndFilters')}</Button>
    {:else if onRefresh}
      <Button variant="secondary" size="sm" class="mt-4" onclick={() => onRefresh?.()}>{t('mail.refreshList')}</Button>
    {/if}
  </div>
</div>
