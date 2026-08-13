<script lang="ts">
  import Dialog from './Dialog.svelte';
  import Button from './Button.svelte';

  let {
    open = false,
    title = '确认操作',
    description,
    confirmLabel = '确认',
    cancelLabel = '取消',
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
</script>

<Dialog {open} {title} {description} size="sm" onClose={onCancel}>
  {#snippet footer()}
    <Button variant="ghost" disabled={pending} onclick={onCancel}>{cancelLabel}</Button>
    <Button {variant} loading={pending} onclick={() => onConfirm?.()}>{confirmLabel}</Button>
  {/snippet}
</Dialog>
