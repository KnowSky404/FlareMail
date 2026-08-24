<script lang="ts">
  import CheckCircle2 from '@lucide/svelte/icons/circle-check-big';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Info from '@lucide/svelte/icons/info';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import X from '@lucide/svelte/icons/x';
  import type { ToastMessage } from '$lib/client/toast-controller';

  let {
    toast,
    onAction,
    onDismiss
  }: {
    toast: ToastMessage;
    onAction: () => void | Promise<void>;
    onDismiss: () => void;
  } = $props();
</script>

<section
  class="toast"
  class:success={toast.tone === 'success'}
  class:warning={toast.tone === 'warning'}
  class:error={toast.tone === 'error'}
  role={toast.tone === 'error' ? 'alert' : 'status'}
>
  <span class="icon" aria-hidden="true">
    {#if toast.tone === 'success'}
      <CheckCircle2 size={18} />
    {:else if toast.tone === 'warning'}
      <TriangleAlert size={18} />
    {:else if toast.tone === 'error'}
      <CircleAlert size={18} />
    {:else}
      <Info size={18} />
    {/if}
  </span>
  <div class="content">
    <p>{toast.message}</p>
    {#if toast.requestId}<small>详情 ID：{toast.requestId}</small>{/if}
  </div>
  {#if toast.actionLabel}
    <button class="action" type="button" onclick={onAction}>{toast.actionLabel}</button>
  {/if}
  <button class="dismiss" type="button" aria-label="关闭通知" onclick={onDismiss}>
    <X size={16} aria-hidden="true" />
  </button>
</section>

<style>
  .toast {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 10px;
    min-height: 48px;
    padding: 8px 8px 8px 12px;
    border: 1px solid var(--fm-border);
    border-left: 3px solid var(--fm-primary);
    border-radius: var(--radius-md);
    color: var(--fm-text);
    background: var(--fm-surface);
    box-shadow: var(--fm-shadow-overlay);
    pointer-events: auto;
  }

  .toast.success { border-left-color: var(--fm-success); }
  .toast.warning { border-left-color: var(--fm-warning); }
  .toast.error { border-left-color: var(--fm-danger); }
  .icon { display: inline-flex; color: var(--fm-primary); }
  .success .icon { color: var(--fm-success); }
  .warning .icon { color: var(--fm-warning); }
  .error .icon { color: var(--fm-danger); }
  .content { min-width: 0; }
  p { margin: 0; overflow-wrap: anywhere; font-size: 13px; line-height: 1.45; }
  small { display: block; margin-top: 2px; color: var(--fm-text-muted); font-size: 11px; }
  button { min-width: 44px; min-height: 44px; border: 0; color: inherit; background: transparent; cursor: pointer; }
  .action { padding: 0 8px; color: var(--fm-primary); font-size: 12px; font-weight: 650; }
  .dismiss { display: grid; width: 44px; place-items: center; color: var(--fm-text-muted); }
  button:hover { background: var(--fm-surface-hover); }

  @media (prefers-reduced-motion: no-preference) {
    .toast { animation: toast-in 140ms ease-out; }
    @keyframes toast-in { from { opacity: 0; transform: translateY(6px); } }
  }

  @media (max-width: 520px) {
    .toast { grid-template-columns: auto minmax(0, 1fr) auto; }
    .action { grid-column: 2 / -1; justify-self: start; }
  }
</style>
