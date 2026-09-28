<script lang="ts">
  import { X } from '@lucide/svelte';
  import { IconButton } from '$lib/components/ui';
  import type { MailAddress } from '$lib/domain/mail';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    address,
    field,
    onRemove
  }: {
    address: MailAddress;
    field: 'to' | 'cc' | 'bcc';
    onRemove: () => void;
  } = $props();

  const { t } = useLocale();
  const fieldLabel = $derived(field === 'to' ? t('mail.to') : field === 'cc' ? t('mail.cc') : t('mail.bcc'));
  const removeLabel = $derived(t('compose.removeRecipient', { field: fieldLabel, email: address.email }));
</script>

<span class="recipient-chip inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-[var(--fm-primary-soft)] pl-2 pr-1 text-xs text-[var(--fm-primary)]">
  <span class="min-w-0 truncate" title={address.email}>{address.name || address.email}</span>
  <IconButton
    ariaLabel={removeLabel}
    title={removeLabel}
    size="sm"
    tooltipSide="top"
    class="!rounded-full text-[var(--fm-primary)] hover:bg-[var(--fm-danger-soft)] hover:text-[var(--fm-danger)]"
    onclick={onRemove}
  >
    <X class="size-3" aria-hidden="true" />
  </IconButton>
</span>
