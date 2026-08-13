<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from './styles';

  let { children, class: className = '' }: { children?: Snippet; class?: string } = $props();
</script>

<span class={cn('inline-flex items-center rounded-full border border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] px-2 py-0.5 text-[11px] font-medium leading-4 text-[var(--fm-text-secondary)]', className)}>
  {#if children}{@render children()}{/if}
</span>
