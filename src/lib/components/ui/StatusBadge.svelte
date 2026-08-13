<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn, statusClasses, statusTone, type StatusTone } from './styles';

  let { status, tone, children, class: className = '' }: { status: string; tone?: StatusTone; children?: Snippet; class?: string } = $props();
  const resolvedTone = $derived(tone ?? statusTone(status));
</script>

<span class={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4', statusClasses[resolvedTone].badge, className)}>
  <span class={`size-1.5 rounded-full ${statusClasses[resolvedTone].dot}`} aria-hidden="true"></span>
  {#if children}{@render children()}{:else}{status}{/if}
</span>
