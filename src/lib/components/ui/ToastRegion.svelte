<script lang="ts">
  import type { ToastMessage } from '$lib/client/toast-controller';
  import Toast from './Toast.svelte';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    messages = [],
    aboveActions = false,
    aboveSettingsSave = false,
    onAction,
    onDismiss
  }: {
    messages?: ToastMessage[];
    aboveActions?: boolean;
    aboveSettingsSave?: boolean;
    onAction: (id: string) => void | Promise<void>;
    onDismiss: (id: string) => void;
  } = $props();
  const { t } = useLocale();
</script>

<div class:above-actions={aboveActions} class:above-settings-save={aboveSettingsSave} class="toast-region" aria-label={t('common.notifications')} aria-live="polite" aria-relevant="additions text">
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

  .toast-region.above-actions {
    bottom: calc(144px + env(safe-area-inset-bottom));
  }

  .toast-region.above-settings-save {
    bottom: calc(96px + env(safe-area-inset-bottom));
  }

  @media (max-width: 600px) {
    .toast-region.above-actions {
      bottom: calc(112px + env(safe-area-inset-bottom));
    }
  }

</style>
