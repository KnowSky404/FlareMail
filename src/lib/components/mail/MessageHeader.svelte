<script lang="ts">
  import {
    Archive,
    ArrowLeft,
    ArrowUpRight,
    ChevronDown,
    Forward,
    Maximize2,
    Mail,
    MoreHorizontal,
    Reply,
    ReplyAll,
    RotateCcw,
    Star,
    Trash2,
    X
  } from '@lucide/svelte';
  import {
    parseAddressList,
    serializeAddressList,
    type DeliveryDetail,
    type InboundMessageDetail,
    type MailMessage
  } from '$lib/domain/mail';
  import { ConfirmDialog, DropdownMenu, IconButton, StatusBadge } from '$lib/components/ui';
  import { formatNumber, translateCount } from '$lib/i18n';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    message = null,
    deliveryDetail = null,
    inboundDetail = null,
    rawDownloadHref = null,
    pending = false,
    inboundDetailPending = false,
    deliveryDetailPending = false,
    showBack = false,
    onBack,
    onEditDraft,
    onForward,
    onReply,
    onReplyAll,
    onToggleStar,
    onToggleRead,
    onRemove,
    onRestore,
    onPermanentDelete,
    onReloadInboundDetail,
    onReloadDeliveryDetail,
    onRetryDelivery,
    onOpenReader,
    onCloseReader,
    standaloneHref,
    trashMode = false
  }: {
    message?: MailMessage | null;
    deliveryDetail?: DeliveryDetail | null;
    inboundDetail?: InboundMessageDetail | null;
    rawDownloadHref?: string | null;
    pending?: boolean;
    inboundDetailPending?: boolean;
    deliveryDetailPending?: boolean;
    showBack?: boolean;
    onBack?: () => void;
    onEditDraft?: (message: MailMessage) => void | Promise<void>;
    onForward?: (message: MailMessage) => void;
    onReply?: (message: MailMessage) => void;
    onReplyAll?: (message: MailMessage) => void;
    onToggleStar?: (message: MailMessage) => void | Promise<void>;
    onToggleRead?: (message: MailMessage) => void | Promise<void>;
    onRemove?: (message: MailMessage) => void | Promise<void>;
    onRestore?: (message: MailMessage) => void | Promise<void>;
    onPermanentDelete?: (message: MailMessage) => void | Promise<void>;
    onReloadInboundDetail?: (message: MailMessage) => void | Promise<void>;
    onReloadDeliveryDetail?: (message: MailMessage) => void | Promise<void>;
    onRetryDelivery?: (message: MailMessage) => void | Promise<void>;
    onOpenReader?: (message: MailMessage) => void;
    onCloseReader?: () => void;
    standaloneHref?: string | null;
    trashMode?: boolean;
  } = $props();

  let removeConfirmOpen = $state(false);
  let actionsMenuOpen = $state(false);
  let subjectExpanded = $state(false);
  const i18n = useLocale();
  const { t } = i18n;

  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(i18n.locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));

  const formatCompactDate = (value: string) =>
    new Intl.DateTimeFormat(i18n.locale, { month: 'short', day: 'numeric' }).format(new Date(value));

  const formatBytes = (value: number) => {
    if (value < 1024) return `${formatNumber(value, i18n.locale)} B`;
    if (value < 1024 * 1024) return `${formatNumber(value / 1024, i18n.locale, { maximumFractionDigits: 1 })} KB`;
    return `${formatNumber(value / (1024 * 1024), i18n.locale, { maximumFractionDigits: 1 })} MB`;
  };

  const safeHref = (value: string | null | undefined) => {
    if (!value) return null;
    try {
      const url = new URL(value, 'https://flaremail.invalid');
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return value;
    } catch {
      return null;
    }
  };

  const senderName = $derived(message?.folder === 'inbox' ? message.fromName : message?.toName);
  const senderEmail = $derived(message?.folder === 'inbox' ? message.fromEmail : message?.toEmail);
  const counterpartLabel = $derived(message?.folder === 'inbox' ? t('mail.from') : t('mail.to'));
  const downloadHref = $derived(safeHref(rawDownloadHref));
  const deliveryStatus = $derived(message?.folder === 'sent' ? (message.deliveryStatus ?? 'submitted') : null);
  const technicalToSummary = $derived(inboundDetail ? serializeAddressList(inboundDetail.toAddresses) : '');
  const technicalCcSummary = $derived(inboundDetail ? serializeAddressList(inboundDetail.ccAddresses) : '');
  const replyToSummary = $derived(inboundDetail ? serializeAddressList(inboundDetail.replyTo) : '');
  const toSummary = $derived(message
    ? message.source === 'inbound'
      ? technicalToSummary
      : serializeAddressList(message.toAddresses ?? [{ name: message.toName, email: message.toEmail }])
    : '');
  const ccSummary = $derived(message
    ? serializeAddressList(message.ccAddresses ?? parseAddressList(message.cc ?? ''))
    : '');
  const bccSummary = $derived(message
    ? serializeAddressList(message.bccAddresses ?? parseAddressList(message.bcc ?? ''))
    : '');

  const deliveryLabel = (status: string | null) => {
    const labels: Record<string, string> = {
      draft: t('mail.statusDraft'),
      queued: t('mail.statusQueued'),
      submitting: t('mail.statusSubmitting'),
      submitted: t('mail.statusSubmitted'),
      sent: t('mail.statusSent'),
      delivered: t('mail.statusDelivered'),
      delayed: t('mail.statusDelayed'),
      bounced: t('mail.statusBounced'),
      failed: t('mail.statusFailed'),
      complained: t('mail.statusComplained'),
      suppressed: t('mail.statusSuppressed')
    };
    return status ? labels[status] ?? status : '';
  };

  const deliveryTone = (status: string | null): 'success' | 'warning' | 'danger' | 'neutral' => {
    if (status === 'delivered' || status === 'sent') return 'success';
    if (status === 'queued' || status === 'submitting' || status === 'submitted' || status === 'delayed') return 'warning';
    if (status === 'bounced' || status === 'failed' || status === 'complained' || status === 'suppressed') return 'danger';
    return 'neutral';
  };

  const canRetry = $derived(
    Boolean(
      message?.folder === 'sent' &&
        ((message.deliveryStatus && ['queued', 'submitting', 'submitted', 'delayed', 'failed'].includes(message.deliveryStatus)) ||
          message.deliveryResultKind === 'temporary_failure' ||
          message.deliveryResultKind === 'rate_limited')
    )
  );
  const hasActions = $derived(Boolean(
    trashMode
      ? onRestore || onPermanentDelete
      : standaloneHref || onEditDraft || onToggleRead || onRemove || onReloadInboundDetail || onReloadDeliveryDetail || onRetryDelivery || downloadHref
  ));
  const longSubject = $derived((message?.subject ?? '').length > 88);
</script>

{#if message}
  <header class="flex-none border-b border-[var(--fm-border)] bg-[var(--fm-surface)]">
    <div class="message-header-row flex min-h-12 items-center gap-1 border-b border-[var(--fm-border)] px-3 py-1 sm:px-5">
      {#if showBack}
        <IconButton ariaLabel={t('mail.backToList')} title={t('mail.backToList')} size="sm" class="shrink-0 xl:hidden" onclick={() => onBack?.()}>
          <ArrowLeft class="size-4" aria-hidden="true" />
        </IconButton>
      {/if}
      <div class="message-subject min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <h1 class:subject-collapsed={longSubject && !subjectExpanded} class="min-w-0 flex-1 text-base font-semibold text-[var(--fm-text)] sm:text-lg" title={message.subject || t('mail.noSubject')}>{message.subject || t('mail.noSubject')}</h1>
          {#if longSubject}
            <button class="subject-toggle fm-touch-target shrink-0" type="button" aria-expanded={subjectExpanded} onclick={() => (subjectExpanded = !subjectExpanded)}>
              {subjectExpanded ? t('mail.collapseSubject') : t('mail.expandSubject')}
            </button>
          {/if}
          {#if message.folder === 'sent' && deliveryStatus}
            <span class="hidden shrink-0 sm:inline-flex">
              <StatusBadge status={deliveryStatus} tone={deliveryTone(deliveryStatus)}>{deliveryLabel(deliveryStatus)}</StatusBadge>
            </span>
          {/if}
        </div>
      </div>
      <div class="message-header-tools flex shrink-0 items-center gap-0.5">
        {#if !trashMode && onOpenReader}
          <IconButton ariaLabel={t('mail.openReader')} title={t('mail.openReader')} size="sm" class="hidden sm:inline-flex" onclick={() => onOpenReader?.(message)}>
            <Maximize2 class="size-4" aria-hidden="true" />
          </IconButton>
          {#if standaloneHref}
            <a class="fm-touch-target hidden size-8 place-items-center rounded-[var(--radius-md)] text-[var(--fm-text-muted)] hover:bg-[var(--fm-surface-hover)] hover:text-[var(--fm-text)] sm:grid" href={standaloneHref} target="_blank" rel="noopener noreferrer" aria-label={t('mail.openNewWindow')} title={t('mail.openNewWindow')}>
              <ArrowUpRight class="size-4" aria-hidden="true" />
            </a>
          {/if}
        {/if}
        {#if !trashMode && onToggleStar}
          <IconButton ariaLabel={message.starred ? t('mail.unstar') : t('mail.star')} title={message.starred ? t('mail.unstar') : t('mail.star')} size="sm" ariaPressed={message.starred} class={message.starred ? 'text-[var(--fm-brand-orange)]' : 'text-[var(--fm-text-muted)]'} onclick={() => onToggleStar?.(message)} disabled={pending}>
            <Star class="size-4" fill={message.starred ? 'currentColor' : 'none'} aria-hidden="true" />
          </IconButton>
        {/if}
        {#if !trashMode && onToggleRead}
          <IconButton ariaLabel={message.read ? t('mail.markUnread') : t('mail.markRead')} title={message.read ? t('mail.markUnread') : t('mail.markRead')} size="sm" class="hidden text-[var(--fm-text-muted)] sm:inline-flex" onclick={() => onToggleRead?.(message)} disabled={pending}>
            <Mail class="size-4" aria-hidden="true" />
          </IconButton>
        {/if}
        {#if hasActions}
          <DropdownMenu id="message-actions" open={actionsMenuOpen} align="end" showChevron={false} triggerAriaLabel={t('mail.moreActions')} triggerTitle={t('mail.moreActions')} class="message-actions-menu" onOpenChange={(open) => (actionsMenuOpen = open)}>
            {#snippet trigger()}
              <MoreHorizontal class="size-[18px]" aria-hidden="true" />
            {/snippet}
            {#snippet children()}
              {#if trashMode}
                {#if onRestore}<button class="menu-action fm-touch-target" role="menuitem" type="button" onclick={() => onRestore?.(message)}><RotateCcw class="size-4" aria-hidden="true" />{t('mail.restoreOriginal')}</button>{/if}
                {#if onPermanentDelete}<button class="menu-action fm-touch-target text-[var(--fm-danger)]" role="menuitem" type="button" onclick={() => (removeConfirmOpen = true)}><Trash2 class="size-4" aria-hidden="true" />{t('mail.permanentDelete')}</button>{/if}
              {:else}
                {#if standaloneHref}<a class="menu-action fm-touch-target" role="menuitem" href={standaloneHref} target="_blank" rel="noopener noreferrer"><ArrowUpRight class="size-4" aria-hidden="true" />{t('mail.openNewWindowShort')}</a>{/if}
                {#if message.folder === 'drafts' && onEditDraft}<button class="menu-action fm-touch-target" role="menuitem" type="button" onclick={() => onEditDraft?.(message)}><Archive class="size-4" aria-hidden="true" />{t('mail.continueDraft')}</button>{/if}
                {#if message.folder === 'inbox' && onToggleRead}<button class="menu-action fm-touch-target" role="menuitem" type="button" onclick={() => onToggleRead?.(message)}><Mail class="size-4" aria-hidden="true" />{message.read ? t('mail.markUnread') : t('mail.markRead')}</button>{/if}
                {#if message.source === 'inbound' && onReloadInboundDetail}<button class="menu-action fm-touch-target" role="menuitem" type="button" onclick={() => onReloadInboundDetail?.(message)} disabled={pending || inboundDetailPending}><RotateCcw class="size-4" aria-hidden="true" />{inboundDetailPending ? t('mail.loadingBody') : t('mail.reloadBody')}</button>{/if}
                {#if message.folder === 'sent' && onReloadDeliveryDetail}<button class="menu-action fm-touch-target" role="menuitem" type="button" onclick={() => onReloadDeliveryDetail?.(message)} disabled={pending || deliveryDetailPending}><RotateCcw class="size-4" aria-hidden="true" />{deliveryDetailPending ? t('mail.loadingReceipt') : t('mail.reloadReceipt')}</button>{/if}
                {#if canRetry && onRetryDelivery}<button class="menu-action fm-touch-target" role="menuitem" type="button" onclick={() => onRetryDelivery?.(message)} disabled={pending}><RotateCcw class="size-4" aria-hidden="true" />{t('mail.retryDelivery')}</button>{/if}
                {#if downloadHref}<a class="menu-action fm-touch-target" role="menuitem" href={downloadHref} download rel="noopener noreferrer"><ArrowUpRight class="size-4" aria-hidden="true" />{t('mail.downloadRaw')}</a>{/if}
                {#if onRemove}<button class="menu-action fm-touch-target text-[var(--fm-danger)]" role="menuitem" type="button" onclick={() => (removeConfirmOpen = true)}><Trash2 class="size-4" aria-hidden="true" />{t('mail.moveTrash')}</button>{/if}
              {/if}
            {/snippet}
          </DropdownMenu>
        {/if}
        {#if onCloseReader}
          <IconButton ariaLabel={t('reader.close')} title={t('reader.close')} size="sm" class="text-[var(--fm-text-secondary)]" onclick={() => onCloseReader?.()}>
            <X class="size-4" aria-hidden="true" />
          </IconButton>
        {/if}
      </div>
      <nav class="message-primary-actions flex shrink-0 items-center gap-1" aria-label={t('mail.actions')}>
        {#if trashMode}
          {#if onRestore}<IconButton ariaLabel={t('mail.restore')} title={t('mail.restore')} variant="primary" size="sm" onclick={() => onRestore?.(message)} disabled={pending}><RotateCcw class="size-4" aria-hidden="true" /></IconButton>{/if}
          {#if onPermanentDelete}<IconButton ariaLabel={t('mail.permanentDelete')} title={t('mail.permanentDelete')} variant="danger" size="sm" onclick={() => (removeConfirmOpen = true)} disabled={pending}><Trash2 class="size-4" aria-hidden="true" /></IconButton>{/if}
        {:else if message.folder !== 'drafts'}
          {#if onReply}<IconButton ariaLabel={t('mail.reply')} title={t('mail.reply')} variant="primary" size="sm" onclick={() => onReply?.(message)} disabled={pending}><Reply class="size-4" aria-hidden="true" /></IconButton>{/if}
          {#if onReplyAll}
            <IconButton ariaLabel={t('mail.replyAll')} title={t('mail.replyAll')} variant="outline" size="sm" onclick={() => onReplyAll?.(message)} disabled={pending}><ReplyAll class="size-4" aria-hidden="true" /></IconButton>
          {/if}
        {/if}
        {#if !trashMode}
          {#if message.folder !== 'drafts' && onForward}
            <IconButton ariaLabel={t('mail.forward')} title={t('mail.forward')} variant="outline" size="sm" onclick={() => onForward?.(message)} disabled={pending}><Forward class="size-4" aria-hidden="true" /></IconButton>
          {/if}
        {/if}
      </nav>
    </div>

    <div class="px-4 pb-3 pt-2 sm:px-5 sm:pb-3 sm:pt-3">
      <div class="flex items-start gap-3">
        <div class="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--fm-primary-soft)] text-sm font-semibold text-[var(--fm-primary)]" aria-hidden="true">
          {(senderName || senderEmail || '?').slice(0, 1).toUpperCase()}
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span class="font-medium text-[var(--fm-text)]">{senderName || senderEmail || t('mail.unknownContact')}</span>
            <span class="truncate text-xs text-[var(--fm-text-secondary)]">&lt;{senderEmail || t('mail.unknownAddress')}&gt;</span>
          </div>
          <details class="mt-1 text-xs text-[var(--fm-text-muted)]">
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
              {#if message.messageId}<dt>{t('mail.messageId')}</dt><dd class="truncate font-mono text-[var(--fm-text-secondary)]">{message.messageId}</dd>{/if}
            </dl>
          </details>
          {#if inboundDetail}
            <details class="mt-1 text-xs text-[var(--fm-text-muted)]">
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
        <time class="shrink-0 text-right text-xs text-[var(--fm-text-muted)]" datetime={message.sentAt} title={formatDate(message.sentAt)}>{formatCompactDate(message.sentAt)}</time>
      </div>

      <div class="mt-2 flex flex-wrap items-center gap-2">
        {#if message.folder === 'sent' && deliveryStatus}
          <span class="inline-flex sm:hidden"><StatusBadge status={deliveryStatus} tone={deliveryTone(deliveryStatus)}>{deliveryLabel(deliveryStatus)}</StatusBadge></span>
        {/if}
        {#if message.labels.length}
          {#each message.labels as label}<span class="rounded-full bg-[var(--fm-surface-subtle)] px-2 py-0.5 text-[11px] text-[var(--fm-text-secondary)]">{label}</span>{/each}
        {/if}
        {#if inboundDetail}
          <span class="text-xs text-[var(--fm-text-muted)]">{translateCount(i18n.locale, 'mail.attachmentSummary', inboundDetail.attachments.length, { size: formatBytes(inboundDetail.rawSize) })}</span>
        {/if}
      </div>

    </div>
  </header>
{:else}
  <header class="flex-none border-b border-[var(--fm-border)] px-5 py-4"><h1 class="text-base font-semibold text-[var(--fm-text)]">{t('mail.detail')}</h1></header>
{/if}

{#if message}
  <ConfirmDialog
    id={`message-remove-confirm-${message.id}`}
    open={removeConfirmOpen}
    title={trashMode ? t('mail.permanentDeleteConfirm') : t('mail.moveTrashConfirm')}
    description={trashMode ? t('mail.permanentDeleteDescription') : t('mail.moveTrashDescription')}
    confirmLabel={trashMode ? t('mail.permanentDelete') : t('mail.moveTrash')}
    {pending}
    onCancel={() => (removeConfirmOpen = false)}
    onConfirm={async () => {
      if (trashMode) await onPermanentDelete?.(message);
      else await onRemove?.(message);
      removeConfirmOpen = false;
    }}
  />
{/if}

<style>
  .subject-collapsed {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .message-subject h1 {
    overflow-wrap: anywhere;
  }

  .subject-toggle {
    border-radius: var(--radius-sm);
    padding: 0 0.25rem;
    color: var(--fm-primary);
    font-size: 10px;
    font-weight: 600;
    white-space: nowrap;
  }

  .subject-toggle:hover { background: var(--fm-primary-soft); }

  .menu-action { display: flex; width: 100%; min-height: 36px; align-items: center; gap: 0.5rem; border-radius: var(--radius-md); padding: 0.55rem 0.625rem; text-align: left; font-size: 0.75rem; color: var(--fm-text-secondary); }
  .menu-action:hover { background: var(--fm-surface-hover); color: var(--fm-text); }

  :global(.message-actions-menu > button) {
    display: grid;
    width: var(--control-compact);
    height: var(--control-compact);
    place-items: center;
    gap: 0;
    padding: 0;
    border-radius: var(--radius-md);
    color: var(--fm-text-muted);
  }

  :global(.message-actions-menu > button:hover) { background: var(--fm-surface-hover); color: var(--fm-text); }
  :global(.message-actions-menu > button > svg:last-child) { display: none; }
  :global(.message-actions-menu [role='menu']) { width: 13rem; }

  @media (max-width: 900px) {
    .message-header-row {
      flex-wrap: wrap;
    }

    .message-primary-actions {
      flex-basis: 100%;
      justify-content: flex-end;
      border-top: 1px solid var(--fm-border);
      padding-top: 0.25rem;
    }

    :global(.message-actions-menu > button) {
      width: 44px;
      height: 44px;
    }

    .menu-action { min-height: 44px; }
  }
</style>
