<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from './styles';

  let {
    children,
    header,
    footer,
    title,
    description,
    class: className = '',
    contentClass = ''
  }: {
    children?: Snippet;
    header?: Snippet;
    footer?: Snippet;
    title?: string;
    description?: string;
    class?: string;
    contentClass?: string;
  } = $props();
</script>

<section class={cn('overflow-hidden rounded-[var(--radius-lg)] border border-[var(--fm-border)] bg-[var(--fm-surface)]', className)}>
  {#if header || title || description}<header class="flex items-start justify-between gap-4 border-b border-[var(--fm-border)] px-4 py-3">{#if title || description}<div>{#if title}<h2 class="text-sm font-semibold text-[var(--fm-text)]">{title}</h2>{/if}{#if description}<p class="mt-0.5 text-xs text-[var(--fm-text-muted)]">{description}</p>{/if}</div>{/if}{#if header}{@render header()}{/if}</header>{/if}
  {#if children}<div class={cn('p-4', contentClass)}>{@render children()}</div>{/if}
  {#if footer}<footer class="border-t border-[var(--fm-border)] px-4 py-3">{@render footer()}</footer>{/if}
</section>
