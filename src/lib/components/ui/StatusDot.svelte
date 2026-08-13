<script lang="ts">
  import { cn, statusClasses, statusTone, type StatusTone } from './styles';

  let { status, tone, label, class: className = '' }: { status: string; tone?: StatusTone; label?: string; class?: string } = $props();
  const resolvedTone = $derived(tone ?? statusTone(status));
</script>

<span class={cn('inline-flex items-center gap-1.5 text-xs text-[var(--fm-text-muted)]', className)}>
  <span class={`size-2 rounded-full ${statusClasses[resolvedTone].dot}`} aria-hidden="true"></span>
  {#if label}{label}{/if}
</span>
