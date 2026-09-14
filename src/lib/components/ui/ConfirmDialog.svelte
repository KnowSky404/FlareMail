<script lang="ts">
  import Dialog from './Dialog.svelte';
  import Button from './Button.svelte';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    open = false,
    title,
    description,
    confirmLabel,
    cancelLabel,
    variant = 'danger',
    pending = false,
    onConfirm,
    onCancel
  }: {
    open?: boolean;
    title?: string;
    description: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'primary' | 'danger';
    pending?: boolean;
    onConfirm?: () => void | Promise<void>;
    onCancel?: () => void;
  } = $props();
  const { t } = useLocale();
  const dialogTitle = $derived(title ?? t('common.confirmAction'));
  const dialogConfirm = $derived(confirmLabel ?? t('common.confirm'));
  const dialogCancel = $derived(cancelLabel ?? t('common.cancel'));
</script>

<Dialog {open} title={dialogTitle} {description} size="sm" onClose={onCancel}>
  {#snippet footer()}
    <Button variant="ghost" disabled={pending} onclick={onCancel}>{dialogCancel}</Button>
    <Button {variant} loading={pending} onclick={() => onConfirm?.()}>{dialogConfirm}</Button>
  {/snippet}
</Dialog>
