<script lang="ts">
  import type { Snippet } from 'svelte';
  import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from '@lucide/svelte';
  import { cn } from './styles';

  type BannerVariant = 'info' | 'success' | 'warning' | 'danger';
  let {
    variant = 'info',
    title,
    children,
    dismissible = false,
    onDismiss,
    class: className = ''
  }: {
    variant?: BannerVariant;
    title?: string;
    children?: Snippet;
    dismissible?: boolean;
    onDismiss?: () => void;
    class?: string;
  } = $props();

  const icons = { info: Info, success: CheckCircle2, warning: TriangleAlert, danger: AlertCircle };
  const Icon = $derived(icons[variant]);
  const toneClasses = {
    info: 'border-[color-mix(in_srgb,var(--fm-info)_35%,var(--fm-surface))] bg-[var(--fm-info-soft)] text-[var(--fm-info)]',
    success: 'border-[color-mix(in_srgb,var(--fm-success)_35%,var(--fm-surface))] bg-[var(--fm-success-soft)] text-[var(--fm-success)]',
    warning: 'border-[color-mix(in_srgb,var(--fm-warning)_35%,var(--fm-surface))] bg-[var(--fm-warning-soft)] text-[var(--fm-warning)]',
    danger: 'border-[color-mix(in_srgb,var(--fm-danger)_35%,var(--fm-surface))] bg-[var(--fm-danger-soft)] text-[var(--fm-danger)]'
  };
</script>

<div class={cn('flex items-start gap-3 rounded-[var(--radius-md)] border px-3 py-2.5 text-sm', toneClasses[variant], className)} role={variant === 'danger' ? 'alert' : 'status'}>
  <Icon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
  <div class="min-w-0 flex-1">{#if title}<p class="font-semibold">{title}</p>{/if}{#if children}<div class={title ? 'mt-0.5' : ''}>{@render children()}</div>{/if}</div>
  {#if dismissible}<button class="rounded p-0.5 opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current" aria-label="关闭提示" type="button" onclick={onDismiss}><X class="size-4" aria-hidden="true" /></button>{/if}
</div>
