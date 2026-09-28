<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from './styles';

  type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';
  type AvatarTone = 'primary' | 'neutral';

  let {
    name = '',
    initials,
    size = 'md',
    tone = 'primary',
    children,
    class: className = ''
  }: {
    name?: string;
    initials?: string;
    size?: AvatarSize;
    tone?: AvatarTone;
    children?: Snippet;
    class?: string;
  } = $props();

  const sizeClasses: Record<AvatarSize, string> = {
    xs: 'size-7 text-[11px] font-extrabold',
    sm: 'size-8 text-xs font-semibold',
    md: 'size-9 text-xs font-semibold',
    lg: 'size-10 text-sm font-semibold'
  };
  const toneClasses: Record<AvatarTone, string> = {
    primary: 'bg-[var(--fm-primary-soft)] text-[var(--fm-primary)]',
    neutral: 'bg-[var(--fm-surface-subtle)] text-[var(--fm-text-secondary)]'
  };
  const avatarText = $derived(initials ?? (Array.from(name.trim())[0]?.toUpperCase() || '?'));
</script>

<span class={cn('fm-avatar grid shrink-0 place-items-center rounded-full', sizeClasses[size], toneClasses[tone], className)} aria-hidden="true">
  {#if children}{@render children()}{:else}{avatarText}{/if}
</span>
