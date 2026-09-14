<script lang="ts">
  import { ChevronLeft, ChevronRight, MoreHorizontal } from '@lucide/svelte';
  import { buttonClass, cn } from './styles';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    page,
    pageCount,
    onChange,
    disabled = false,
    class: className = ''
  }: { page: number; pageCount: number; onChange?: (page: number) => void; disabled?: boolean; class?: string } = $props();

  const visiblePages = $derived.by(() => {
    if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
    if (page <= 4) return [1, 2, 3, 4, 5, -1, pageCount];
    if (page >= pageCount - 3) return [1, -1, pageCount - 4, pageCount - 3, pageCount - 2, pageCount - 1, pageCount];
    return [1, -1, page - 1, page, page + 1, -1, pageCount];
  });
  const { t } = useLocale();
</script>

{#if pageCount > 1}
  <nav class={cn('flex items-center justify-between gap-3 text-sm', className)} aria-label={t('common.pagination')}>
    <button class={buttonClass('ghost', 'sm')} disabled={disabled || page <= 1} aria-label={t('common.previousPage')} type="button" onclick={() => onChange?.(page - 1)}><ChevronLeft class="size-4" aria-hidden="true" /><span class="hidden sm:inline">{t('common.previousPage')}</span></button>
    <div class="flex items-center gap-1">
      {#each visiblePages as item, index (`${item}-${index}`)}
        {#if item === -1}<span class="grid size-8 place-items-center text-[var(--fm-text-muted)]"><MoreHorizontal class="size-4" aria-hidden="true" /></span>
        {:else}<button class={cn(buttonClass(item === page ? 'primary' : 'ghost', 'sm'), 'size-8 !px-0')} aria-current={item === page ? 'page' : undefined} disabled={disabled} type="button" onclick={() => onChange?.(item)}>{item}</button>{/if}
      {/each}
    </div>
    <button class={buttonClass('ghost', 'sm')} disabled={disabled || page >= pageCount} aria-label={t('common.nextPage')} type="button" onclick={() => onChange?.(page + 1)}><span class="hidden sm:inline">{t('common.nextPage')}</span><ChevronRight class="size-4" aria-hidden="true" /></button>
  </nav>
{/if}
