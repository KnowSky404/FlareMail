<script lang="ts">
  import { cn } from './styles';

  let { class: className = '', width = '', height = '' }: { class?: string; width?: string; height?: string } = $props();
</script>

<span class={cn('block animate-pulse rounded-[var(--radius-md)] bg-[var(--fm-surface-subtle)]', className)} style={`width:${width || '100%'};height:${height || '1rem'}`} aria-hidden="true"></span>
