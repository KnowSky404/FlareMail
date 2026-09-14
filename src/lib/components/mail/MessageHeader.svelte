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
    Trash2
  } from '@lucide/svelte';
  import {
    parseAddressList,
    serializeAddressList,
    type DeliveryDetail,
    type InboundMessageDetail,
    type MailMessage
  } from '$lib/domain/mail';
  import { ConfirmDialog, DropdownMenu, StatusBadge } from '$lib/components/ui';
  import { formatNumber } from '$lib/i18n';
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
    standaloneHref?: string | null;
    trashMode?: boolean;
  } = $props();

  let removeConfirmOpen = $state(false);
  let actionsMenuOpen = $state(false);
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
  const toSummary = $derived(message
    ? serializeAddressList(message.toAddresses ?? [{ name: message.toName, email: message.toEmail }])
    : '');
  const ccSummary = $derived(message
    ? serializeAddressList(message.ccAddresses ?? parseAddressList(message.cc ?? ''))
    : '');
  const bccSummary = $derived(message
    ? serializeAddressList(message.bccAddresses ?? parseAddressList(message.bcc ?? ''))
    : '');
  const technicalToSummary = $derived(inboundDetail ? serializeAddressList(inboundDetail.toAddresses) : '');
  const technicalCcSummary = $derived(inboundDetail ? serializeAddressList(inboundDetail.ccAddresses) : '');
  const replyToSummary = $derived(inboundDetail ? serializeAddressList(inboundDetail.replyTo) : '');

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
      : standaloneHref || onEditDraft || onToggleRead || onRemove
  ));
</script>

{#if message}
  <header class="flex-none border-b border-[var(--fm-border)] bg-[var(--fm-surface)]">
    <div class="flex min-h-14 items-center gap-1 border-b border-[var(--fm-border)] px-3 sm:px-5">
      {#if showBack}
        <button
          class="grid size-11 shrink-0 place-items-center rounded-[var(--radius-md)] text-[var(--fm-text-secondary)] hover:bg-[var(--fm-surface-hover)] hover:text-[var(--fm-text)] xl:hidden"
          aria-label={t('mail.backToList')}
          title={t('mail.backToList')}
          type="button"
          onclick={() => onBack?.()}
        >
          <ArrowLeft class="size-5" aria-hidden="true" />
        </button>
      {/if}
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <h1 class="truncate text-base font-semibold text-[var(--fm-text)] sm:text-lg">{message.subject || t('mail.noSubject')}</h1>
          {#if message.folder === 'sent' && deliveryStatus}
            <StatusBadge status={deliveryStatus} tone={deliveryTone(deliveryStatus)} class="hidden shrink-0 sm:inline-flex">
              {deliveryLabel(deliveryStatus)}
            </StatusBadge>
          {/if}
        </div>
        <p class="truncate text-xs text-[var(--fm-text-muted)]">{message.preview || t('mail.noPreview')}</p>
      </div>
      <div class="flex shrink-0 items-center gap-0.5">
        {#if !trashMode && onOpenReader}
          <button
            class="hidden size-11 place-items-center rounded-[var(--radius-md)] text-[var(--fm-text-muted)] hover:bg-[var(--fm-surface-hover)] hover:text-[var(--fm-text)] sm:grid"
            aria-label={t('mail.openReader')}
            title={t('mail.openReader')}
            type="button"
            onclick={() => onOpenReader?.(message)}
          >
            <Maximize2 class="size-[18px]" aria-hidden="true" />
          </button>
          {#if standaloneHref}
            <a
              class="hidden size-11 place-items-center rounded-[var(--radius-md)] text-[var(--fm-text-muted)] hover:bg-[var(--fm-surface-hover)] hover:text-[var(--fm-text)] sm:grid"
              href={standaloneHref}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('mail.openNewWindow')}
              title={t('mail.openNewWindow')}
            >
              <ArrowUpRight class="size-[18px]" aria-hidden="true" />
            </a>
          {/if}
        {/if}
        {#if !trashMode && onToggleStar}<button
          class="grid size-11 place-items-center rounded-[var(--radius-md)] hover:bg-[var(--fm-surface-hover)]"
          class:text-[var(--fm-brand-orange)]={message.starred}
          class:text-[var(--fm-text-muted)]={!message.starred}
          aria-label={message.starred ? t('mail.unstar') : t('mail.star')}
          title={message.starred ? t('mail.unstar') : t('mail.star')}
          type="button"
          onclick={() => onToggleStar?.(message)}
          disabled={pending}
        >
          <Star class="size-[18px]" fill={message.starred ? 'currentColor' : 'none'} aria-hidden="true" />
        </button>{/if}
        {#if !trashMode && onToggleRead}<button
          class="hidden size-11 place-items-center rounded-[var(--radius-md)] text-[var(--fm-text-muted)] hover:bg-[var(--fm-surface-hover)] hover:text-[var(--fm-text)] sm:grid"
          aria-label={message.read ? t('mail.markUnread') : t('mail.markRead')}
          title={message.read ? t('mail.markUnread') : t('mail.markRead')}
          type="button"
          onclick={() => onToggleRead?.(message)}
          disabled={pending}
        >
          <Mail class="size-[18px]" aria-hidden="true" />
        </button>{/if}
        {#if hasActions}<DropdownMenu
          open={actionsMenuOpen}
          align="end"
          class="message-actions-menu"
          onOpenChange={(open) => (actionsMenuOpen = open)}
        >
          {#snippet trigger()}
            <MoreHorizontal class="size-[18px]" aria-hidden="true" />
            <span class="sr-only">{t('mail.moreActions')}</span>
          {/snippet}
          {#snippet children()}
            {#if trashMode}
              {#if onRestore}<button class="menu-action" role="menuitem" type="button" onclick={() => onRestore?.(message)}><RotateCcw class="size-4" aria-hidden="true" />{t('mail.restoreOriginal')}</button>{/if}
              {#if onPermanentDelete}<button class="menu-action text-[var(--fm-danger)]" role="menuitem" type="button" onclick={() => (removeConfirmOpen = true)}><Trash2 class="size-4" aria-hidden="true" />{t('mail.permanentDelete')}</button>{/if}
            {:else}
              {#if standaloneHref}
                <a class="menu-action" role="menuitem" href={standaloneHref} target="_blank" rel="noopener noreferrer"><ArrowUpRight class="size-4" aria-hidden="true" />{t('mail.openNewWindowShort')}</a>
              {/if}
              {#if message.folder === 'drafts' && onEditDraft}
                <button class="menu-action" role="menuitem" type="button" onclick={() => onEditDraft?.(message)}><Archive class="size-4" aria-hidden="true" />{t('mail.continueDraft')}</button>
              {/if}
              {#if message.folder === 'inbox' && onToggleRead}
                <button class="menu-action" role="menuitem" type="button" onclick={() => onToggleRead?.(message)}><Mail class="size-4" aria-hidden="true" />{message.read ? t('mail.markUnread') : t('mail.markRead')}</button>
              {/if}
              {#if onRemove}<button class="menu-action text-[var(--fm-danger)]" role="menuitem" type="button" onclick={() => (removeConfirmOpen = true)}><Trash2 class="size-4" aria-hidden="true" />{t('mail.moveTrash')}</button>{/if}
            {/if}
          {/snippet}
        </DropdownMenu>
        {/if}
      </div>
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
            <summary class="inline-flex cursor-pointer list-none items-center gap-1 hover:text-[var(--fm-text)]">
              <span>{t('mail.contactDetails', { label: counterpartLabel })}</span><ChevronDown class="size-3" aria-hidden="true" />
            </summary>
            <dl class="mt-2 grid max-w-xl grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-[var(--radius-md)] bg-[var(--fm-surface-subtle)] p-3 leading-5">
              <dt>{t('mail.from')}</dt><dd class="truncate text-[var(--fm-text-secondary)]">{message.fromName} &lt;{message.fromEmail}&gt;</dd>
              <dt>{t('mail.to')}</dt><dd class="break-words text-[var(--fm-text-secondary)]">{toSummary}</dd>
              {#if ccSummary}<dt>{t('mail.cc')}</dt><dd class="break-words text-[var(--fm-text-secondary)]">{ccSummary}</dd>{/if}
              {#if bccSummary}<dt>{t('mail.bcc')}</dt><dd class="break-words text-[var(--fm-text-secondary)]">{bccSummary}</dd>{/if}
              {#if message.messageId}<dt>{t('mail.messageId')}</dt><dd class="truncate font-mono text-[var(--fm-text-secondary)]">{message.messageId}</dd>{/if}
            </dl>
          </details>
          {#if inboundDetail}
            <details class="mt-1 text-xs text-[var(--fm-text-muted)]">
              <summary class="inline-flex cursor-pointer list-none items-center gap-1 hover:text-[var(--fm-text)]">
                <span>{t('mail.technicalDetails')}</span><ChevronDown class="size-3" aria-hidden="true" />
              </summary>
              <div class="mt-2 max-w-3xl rounded-[var(--radius-md)] bg-[var(--fm-surface-subtle)] p-3 leading-5">
                <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                  <dt>{t('mail.to')}</dt><dd class="break-words text-[var(--fm-text-secondary)]">{technicalToSummary || t('mail.notProvided')}</dd>
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
                    <summary class="cursor-pointer font-medium text-[var(--fm-text-secondary)]">{t('mail.filteredHeaders', { count: formatNumber(inboundDetail.headers.length, i18n.locale) })}</summary>
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
        <time class="shrink-0 text-right text-xs text-[var(--fm-text-muted)]" datetime={message.sentAt} title={formatDate(message.sentAt)}>{formatDate(message.sentAt)}</time>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        {#if message.folder === 'sent' && deliveryStatus}
          <StatusBadge status={deliveryStatus} tone={deliveryTone(deliveryStatus)} class="sm:hidden">{deliveryLabel(deliveryStatus)}</StatusBadge>
        {/if}
        {#if message.labels.length}
          {#each message.labels as label}<span class="rounded-full bg-[var(--fm-surface-subtle)] px-2 py-0.5 text-[11px] text-[var(--fm-text-secondary)]">{label}</span>{/each}
        {/if}
        {#if inboundDetail}
          <span class="text-xs text-[var(--fm-text-muted)]">{t('mail.attachmentSummary', { count: formatNumber(inboundDetail.attachments.length, i18n.locale), size: formatBytes(inboundDetail.rawSize) })}</span>
        {/if}
      </div>

      <nav class="mt-3 flex flex-wrap items-center gap-2" aria-label={t('mail.actions')}>
        {#if trashMode}
          {#if onRestore}<button class="action-button action-button-primary" type="button" onclick={() => onRestore?.(message)} disabled={pending}><RotateCcw class="size-4" aria-hidden="true" />{t('mail.restore')}</button>{/if}
          {#if onPermanentDelete}<button class="action-button" type="button" onclick={() => (removeConfirmOpen = true)} disabled={pending}><Trash2 class="size-4" aria-hidden="true" />{t('mail.permanentDelete')}</button>{/if}
        {:else if message.folder !== 'drafts'}
          {#if onReply}<button class="action-button action-button-primary" type="button" onclick={() => onReply?.(message)} disabled={pending}><Reply class="size-4" aria-hidden="true" />{t('mail.reply')}</button>{/if}
          {#if onReplyAll}
            <button class="action-button" type="button" onclick={() => onReplyAll?.(message)} disabled={pending}><ReplyAll class="size-4" aria-hidden="true" />{t('mail.replyAll')}</button>
          {/if}
        {/if}
        {#if !trashMode}
          {#if message.folder !== 'drafts' && onForward}
            <button class="action-button" type="button" onclick={() => onForward?.(message)} disabled={pending}><Forward class="size-4" aria-hidden="true" />{t('mail.forward')}</button>
          {/if}
          {#if message.source === 'inbound' && onReloadInboundDetail}
            <button class="action-button" type="button" onclick={() => onReloadInboundDetail?.(message)} disabled={pending || inboundDetailPending}><RotateCcw class="size-4" aria-hidden="true" />{inboundDetailPending ? t('mail.loadingBody') : t('mail.reloadBody')}</button>
          {/if}
          {#if message.folder === 'sent' && onReloadDeliveryDetail}
            <button class="action-button" type="button" onclick={() => onReloadDeliveryDetail?.(message)} disabled={pending || deliveryDetailPending}><RotateCcw class="size-4" aria-hidden="true" />{deliveryDetailPending ? t('mail.loadingReceipt') : t('mail.reloadReceipt')}</button>
            {#if canRetry && onRetryDelivery}<button class="action-button" type="button" onclick={() => onRetryDelivery?.(message)} disabled={pending}><RotateCcw class="size-4" aria-hidden="true" />{t('mail.retryDelivery')}</button>{/if}
          {/if}
          {#if downloadHref}
            <a class="action-button" href={downloadHref} download rel="noopener noreferrer"><ArrowUpRight class="size-4" aria-hidden="true" />{t('mail.downloadRaw')}</a>
          {/if}
        {/if}
      </nav>
    </div>
  </header>
{:else}
  <header class="flex-none border-b border-[var(--fm-border)] px-5 py-4"><h1 class="text-base font-semibold text-[var(--fm-text)]">{t('mail.detail')}</h1></header>
{/if}

{#if message}
  <ConfirmDialog
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
  .action-button {
    display: inline-flex;
    min-height: 36px;
    align-items: center;
    gap: 0.375rem;
    border: 1px solid var(--fm-border);
    border-radius: var(--radius-md);
    padding: 0.375rem 0.75rem;
    color: var(--fm-text-secondary);
    background: var(--fm-surface);
    font-size: 0.75rem;
    font-weight: 600;
    transition: background var(--motion-fast), color var(--motion-fast), border-color var(--motion-fast);
  }

  .action-button:hover:not(:disabled) { color: var(--fm-text); background: var(--fm-surface-hover); border-color: var(--fm-border-strong); }
  .action-button:disabled { cursor: not-allowed; opacity: 0.5; }
  .action-button-primary { border-color: var(--fm-primary); color: var(--fm-text-inverse); background: var(--fm-primary); }
  .action-button-primary:hover:not(:disabled) { color: var(--fm-text-inverse); background: var(--fm-primary-hover); }
  .menu-action { display: flex; width: 100%; min-height: 36px; align-items: center; gap: 0.5rem; border-radius: var(--radius-md); padding: 0.55rem 0.625rem; text-align: left; font-size: 0.75rem; color: var(--fm-text-secondary); }
  .menu-action:hover { background: var(--fm-surface-hover); color: var(--fm-text); }

  :global(.message-actions-menu > button) {
    display: grid;
    width: 44px;
    height: 44px;
    place-items: center;
    gap: 0;
    border-radius: var(--radius-md);
    color: var(--fm-text-muted);
  }

  :global(.message-actions-menu > button:hover) { background: var(--fm-surface-hover); color: var(--fm-text); }
  :global(.message-actions-menu > button > svg:last-child) { display: none; }
  :global(.message-actions-menu [role='menu']) { width: 13rem; }

  @media (max-width: 767px) {
    .action-button { min-height: 44px; padding-inline: 0.75rem; }
    .menu-action { min-height: 44px; }
  }
</style>
