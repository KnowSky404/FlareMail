<script lang="ts">
  import type { Snippet } from 'svelte';
  import { CheckCircle2, Info, TriangleAlert, X } from '@lucide/svelte';
  import { cn } from './styles';

  type ToastVariant = 'info' | 'success' | 'warning' | 'danger';
  let {
    open = false,
    title,
    message,
    variant = 'info',
    action,
    duration = 5000,
    onClose,
    class: className = ''
  }: {
    open?: boolean;
    title?: string;
    message: string;
    variant?: ToastVariant;
    action?: Snippet;
    duration?: number;
    onClose?: () => void;
    class?: string;
  } = $props();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const icons = { info: Info, success: CheckCircle2, warning: TriangleAlert, danger: TriangleAlert };
  const Icon = $derived(icons[variant]);
  const variants = { info: 'border-[color-mix(in_srgb,var(--fm-info)_35%,var(--fm-surface))]', success: 'border-[color-mix(in_srgb,var(--fm-success)_35%,var(--fm-surface))]', warning: 'border-[color-mix(in_srgb,var(--fm-warning)_35%,var(--fm-surface))]', danger: 'border-[color-mix(in_srgb,var(--fm-danger)_35%,var(--fm-surface))]' };

  $effect(() => {
    if (timer) clearTimeout(timer);
    if (open && duration > 0) timer = setTimeout(() => onClose?.(), duration);
    return () => { if (timer) clearTimeout(timer); };
  });
</script>

{#if open}
  <div class={cn('pointer-events-auto flex w-[min(24rem,calc(100vw-2rem))] items-start gap-3 rounded-[var(--radius-lg)] border bg-[var(--fm-surface)] p-3 shadow-[var(--fm-shadow-overlay)]', variants[variant], className)} role="status" aria-live={variant === 'danger' ? 'assertive' : 'polite'}>
    <Icon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
    <div class="min-w-0 flex-1"><p class="text-sm font-medium">{title ?? message}</p>{#if title}<p class="mt-0.5 text-xs text-[var(--fm-text-muted)]">{message}</p>{/if}{#if action}<div class="mt-2">{@render action()}</div>{/if}</div>
    <button type="button" class="rounded p-0.5 text-[var(--fm-text-muted)] hover:bg-[var(--fm-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fm-focus)]" aria-label="关闭通知" onclick={() => onClose?.()}><X class="size-4" aria-hidden="true" /></button>
  </div>
{/if}
