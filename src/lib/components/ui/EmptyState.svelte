<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Inbox } from '@lucide/svelte';
  import { cn } from './styles';

  let { children, icon: iconSnippet, title = '暂无内容', description, action, class: className = '' }: { children?: Snippet; icon?: Snippet; title?: string; description?: string; action?: Snippet; class?: string } = $props();
</script>

<div class={cn('grid min-h-48 place-items-center px-6 py-10 text-center', className)}>
  <div class="grid justify-items-center">
    <div class="mb-3 grid size-10 place-items-center rounded-full bg-[var(--fm-surface-subtle)] text-[var(--fm-text-muted)]">
      {#if iconSnippet}{@render iconSnippet()}{:else}<Inbox class="size-5" aria-hidden="true" />{/if}
    </div>
    <h2 class="text-sm font-semibold text-[var(--fm-text)]">{title}</h2>
    {#if description}<p class="mt-1 max-w-sm text-xs leading-5 text-[var(--fm-text-muted)]">{description}</p>{/if}
    {#if action}<div class="mt-4">{@render action()}</div>{/if}
    {#if children}<div class="mt-4">{@render children()}</div>{/if}
  </div>
</div>
