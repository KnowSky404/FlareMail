<script lang="ts">
  import type { ToastMessage } from '$lib/client/toast-controller';
  import Toast from './Toast.svelte';

  let {
    messages = [],
    onAction,
    onDismiss
  }: {
    messages?: ToastMessage[];
    onAction: (id: string) => void | Promise<void>;
    onDismiss: (id: string) => void;
  } = $props();
</script>

<div class="toast-region" aria-label="通知" aria-live="polite" aria-relevant="additions text">
  {#each messages as toast (toast.id)}
    <Toast {toast} onAction={() => onAction(toast.id)} onDismiss={() => onDismiss(toast.id)} />
  {/each}
</div>

<style>
  .toast-region {
    position: fixed;
    z-index: 100;
    right: max(16px, env(safe-area-inset-right));
    bottom: max(16px, env(safe-area-inset-bottom));
    display: grid;
    width: min(420px, calc(100vw - 32px));
    gap: 8px;
    pointer-events: none;
  }

</style>
