<script lang="ts">
  import { Inbox, SearchX, Star } from '@lucide/svelte';
  import { Button } from '$lib/components/ui';

  let {
    title = '暂无邮件',
    description = '新的邮件会显示在这里。',
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
    <h2 class="text-sm font-semibold text-[var(--fm-text)]">{title}</h2>
    <p class="mt-1 text-xs leading-5 text-[var(--fm-text-muted)]">{description}</p>
    {#if searchActive || filterActive}
      <Button variant="secondary" size="sm" class="mt-4" onclick={() => onClear?.()}>清除搜索和筛选</Button>
    {:else if onRefresh}
      <Button variant="secondary" size="sm" class="mt-4" onclick={() => onRefresh?.()}>刷新列表</Button>
    {/if}
  </div>
</div>
