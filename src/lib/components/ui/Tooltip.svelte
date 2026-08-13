<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from './styles';

  let { content, children, side = 'top', class: className = '' }: { content: string; children: Snippet; side?: 'top' | 'right' | 'bottom' | 'left'; class?: string } = $props();
  let visible = $state(false);
  const tooltipId = `tooltip-${Math.random().toString(36).slice(2, 8)}`;
  const positions = { top: 'bottom-full left-1/2 mb-2 -translate-x-1/2', right: 'left-full top-1/2 ml-2 -translate-y-1/2', bottom: 'left-1/2 top-full mt-2 -translate-x-1/2', left: 'right-full top-1/2 mr-2 -translate-y-1/2' };
</script>

<span role="presentation" class={cn('relative inline-flex', className)} onmouseenter={() => visible = true} onmouseleave={() => visible = false} onfocusin={() => visible = true} onfocusout={() => visible = false}>
  <span aria-describedby={visible ? tooltipId : undefined}>{@render children()}</span>
  {#if visible}<span id={tooltipId} role="tooltip" class={cn('pointer-events-none absolute z-50 max-w-xs rounded bg-[var(--fm-text)] px-2 py-1 text-[11px] leading-4 text-[var(--fm-text-inverse)] shadow-lg', positions[side])}>{content}</span>{/if}
</span>
