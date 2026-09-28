<script lang="ts">
  import { ChevronDown } from '@lucide/svelte';
  import { parseAddressList, serializeAddressList, type InboundMessageDetail, type MailMessage } from '$lib/domain/mail';
  import { formatNumber, translateCount } from '$lib/i18n';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let { message, inboundDetail = null }: { message: MailMessage; inboundDetail?: InboundMessageDetail | null } = $props();
  const i18n = useLocale();
  const { t } = i18n;

  const counterpartLabel = $derived(message.folder === 'inbox' ? t('mail.from') : t('mail.to'));
  const technicalToSummary = $derived(inboundDetail ? serializeAddressList(inboundDetail.toAddresses) : '');
  const technicalCcSummary = $derived(inboundDetail ? serializeAddressList(inboundDetail.ccAddresses) : '');
  const replyToSummary = $derived(inboundDetail ? serializeAddressList(inboundDetail.replyTo) : '');
  const toSummary = $derived(message.source === 'inbound'
    ? technicalToSummary
    : serializeAddressList(message.toAddresses ?? [{ name: message.toName, email: message.toEmail }]));
  const ccSummary = $derived(serializeAddressList(message.ccAddresses ?? parseAddressList(message.cc ?? '')));
  const bccSummary = $derived(serializeAddressList(message.bccAddresses ?? parseAddressList(message.bcc ?? '')));
  const labels = $derived([
    ...message.labels.map((name, index) => ({ id: `system-${index}`, name, user: false })),
    ...(message.userLabels ?? []).map((label) => ({ id: label.id, name: label.name, user: true }))
  ]);
  const visibleLabels = $derived(labels.slice(0, 3));
  const extraLabels = $derived(labels.slice(3));

  const formatBytes = (value: number) => {
    if (value < 1024) return `${formatNumber(value, i18n.locale)} B`;
    if (value < 1024 * 1024) return `${formatNumber(value / 1024, i18n.locale, { maximumFractionDigits: 1 })} KB`;
    return `${formatNumber(value / (1024 * 1024), i18n.locale, { maximumFractionDigits: 1 })} MB`;
  };
</script>

<div class="border-b border-[var(--fm-border)] px-4 py-2 text-xs text-[var(--fm-text-muted)] sm:px-6 lg:px-8">
  {#if labels.length || inboundDetail}
    <div class="message-header-labels flex flex-wrap items-center gap-2 pb-2">
      {#each visibleLabels as label (label.id)}
        <span class={label.user
          ? 'rounded-full border border-[var(--fm-primary)]/25 bg-[var(--fm-primary-soft)] px-2 py-0.5 text-[11px] text-[var(--fm-primary)]'
          : 'rounded-full bg-[var(--fm-surface-subtle)] px-2 py-0.5 text-[11px] text-[var(--fm-text-secondary)]'}>{label.name}</span>
      {/each}
      {#if inboundDetail}
        <span class="text-xs text-[var(--fm-text-muted)]">{translateCount(i18n.locale, 'mail.attachmentSummary', inboundDetail.attachments.length, { size: formatBytes(inboundDetail.rawSize) })}</span>
      {/if}
    </div>
    {#if extraLabels.length}
      <details class="mb-1">
        <summary class="fm-touch-target inline-flex cursor-pointer list-none items-center gap-1 hover:text-[var(--fm-text)]">
          <span>{translateCount(i18n.locale, 'mail.moreLabels', extraLabels.length)}</span><ChevronDown class="size-3" aria-hidden="true" />
        </summary>
        <div class="message-header-labels mt-2 flex flex-wrap gap-2">
          {#each extraLabels as label (label.id)}
            <span class={label.user
              ? 'rounded-full border border-[var(--fm-primary)]/25 bg-[var(--fm-primary-soft)] px-2 py-0.5 text-[11px] text-[var(--fm-primary)]'
              : 'rounded-full bg-[var(--fm-surface-subtle)] px-2 py-0.5 text-[11px] text-[var(--fm-text-secondary)]'}>{label.name}</span>
          {/each}
        </div>
      </details>
    {/if}
  {/if}
  <details>
    <summary class="fm-touch-target inline-flex cursor-pointer list-none items-center gap-1 hover:text-[var(--fm-text)]">
      <span>{t('mail.contactDetails', { label: counterpartLabel })}</span><ChevronDown class="size-3" aria-hidden="true" />
    </summary>
    <dl class="mt-2 grid max-w-xl grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-[var(--radius-md)] bg-[var(--fm-surface-subtle)] p-3 leading-5">
      <dt>{t('mail.from')}</dt><dd class="truncate text-[var(--fm-text-secondary)]">{message.fromName} &lt;{message.fromEmail}&gt;</dd>
      {#if message.source === 'inbound'}
        <dt>{t('mail.actualDeliveredTo')}</dt><dd class="break-words text-[var(--fm-text-secondary)]">{message.envelopeRecipient || message.toEmail}</dd>
        <dt>{t('mail.to')}</dt><dd class="break-words text-[var(--fm-text-secondary)]">{toSummary || t('mail.notProvided')}</dd>
      {:else}
        <dt>{t('mail.to')}</dt><dd class="break-words text-[var(--fm-text-secondary)]">{toSummary}</dd>
      {/if}
      {#if ccSummary}<dt>{t('mail.cc')}</dt><dd class="break-words text-[var(--fm-text-secondary)]">{ccSummary}</dd>{/if}
      {#if bccSummary}<dt>{t('mail.bcc')}</dt><dd class="break-words text-[var(--fm-text-secondary)]">{bccSummary}</dd>{/if}
      {#if message.messageId}<dt>{t('mail.messageId')}</dt><dd class="break-all font-mono text-[var(--fm-text-secondary)]">{message.messageId}</dd>{/if}
    </dl>
  </details>
  {#if inboundDetail}
    <details class="mt-1">
      <summary class="fm-touch-target inline-flex cursor-pointer list-none items-center gap-1 hover:text-[var(--fm-text)]">
        <span>{t('mail.technicalDetails')}</span><ChevronDown class="size-3" aria-hidden="true" />
      </summary>
      <div class="mt-2 max-w-3xl rounded-[var(--radius-md)] bg-[var(--fm-surface-subtle)] p-3 leading-5">
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt>{t('mail.to')}</dt><dd class="break-words text-[var(--fm-text-secondary)]">{technicalToSummary || t('mail.notProvided')}</dd>
          <dt>{t('mail.actualDeliveredTo')}</dt><dd class="break-words text-[var(--fm-text-secondary)]">{inboundDetail.envelopeRecipient || message.envelopeRecipient || message.toEmail}</dd>
          {#if technicalCcSummary}<dt>{t('mail.cc')}</dt><dd class="break-words text-[var(--fm-text-secondary)]">{technicalCcSummary}</dd>{/if}
          {#if replyToSummary}<dt>{t('mail.replyTo')}</dt><dd class="break-words text-[var(--fm-text-secondary)]">{replyToSummary}</dd>{/if}
          <dt>{t('mail.date')}</dt><dd class="break-words font-mono text-[var(--fm-text-secondary)]">{inboundDetail.date}</dd>
          {#if inboundDetail.messageId}<dt>{t('mail.messageId')}</dt><dd class="break-all font-mono text-[var(--fm-text-secondary)]">{inboundDetail.messageId}</dd>{/if}
          {#if inboundDetail.inReplyTo}<dt>{t('mail.inReplyTo')}</dt><dd class="break-all font-mono text-[var(--fm-text-secondary)]">{inboundDetail.inReplyTo}</dd>{/if}
          {#if inboundDetail.references}<dt>{t('mail.references')}</dt><dd class="break-all font-mono text-[var(--fm-text-secondary)]">{inboundDetail.references}</dd>{/if}
          {#if inboundDetail.returnPath}<dt>{t('mail.returnPath')}</dt><dd class="break-all font-mono text-[var(--fm-text-secondary)]">{inboundDetail.returnPath}</dd>{/if}
          {#if inboundDetail.deliveredTo}<dt>{t('mail.deliveredTo')}</dt><dd class="break-all font-mono text-[var(--fm-text-secondary)]">{inboundDetail.deliveredTo}</dd>{/if}
        </dl>
        {#if inboundDetail.authenticationResults.length}
          <div class="mt-3 border-t border-[var(--fm-border)] pt-2">
            <p class="font-medium text-[var(--fm-text-secondary)]">{t('mail.authenticationResults')}</p>
            <div class="mt-1 flex flex-wrap gap-1.5">
              {#each inboundDetail.authenticationResults as result}
                <span class="rounded-full border border-[var(--fm-border)] bg-[var(--fm-surface)] px-2 py-0.5 font-mono uppercase text-[var(--fm-text-secondary)]">{result.method}={result.result}</span>
              {/each}
            </div>
            <p class="mt-1 text-[11px]">{t('mail.authDisclaimer')}</p>
          </div>
        {/if}
        {#if inboundDetail.headers.length}
          <details class="mt-3 border-t border-[var(--fm-border)] pt-2">
            <summary class="fm-touch-target cursor-pointer font-medium text-[var(--fm-text-secondary)]">{translateCount(i18n.locale, 'mail.filteredHeaders', inboundDetail.headers.length)}</summary>
            <dl class="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              {#each inboundDetail.headers as header}
                <dt class="font-mono">{header.name}</dt><dd class="break-all font-mono text-[var(--fm-text-secondary)]">{header.value}</dd>
              {/each}
            </dl>
          </details>
        {/if}
      </div>
    </details>
  {/if}
</div>
