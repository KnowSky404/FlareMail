<script lang="ts">
  import {
    Archive,
    Inbox,
    ArrowLeft,
    ArrowUpRight,
    Forward,
    Maximize2,
    Mail,
    MoreHorizontal,
    Reply,
    ReplyAll,
    RotateCcw,
    Star,
    Tag,
    Trash2,
    X
  } from '@lucide/svelte';
  import {
    parseAddressList,
    type DeliveryDetail,
    type MailMessage
  } from '$lib/domain/mail';
  import { translateCount } from '$lib/i18n';
  import { Avatar, ConfirmDialog, DropdownMenu, IconButton, StatusBadge } from '$lib/components/ui';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    message = null,
    deliveryDetail = null,
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
    onManageLabels,
    onToggleRead,
    onArchive,
    onRemove,
    onRestore,
    onPermanentDelete,
    onReloadInboundDetail,
    onReloadDeliveryDetail,
    onRetryDelivery,
    onOpenReader,
    onCloseReader,
    standaloneHref,
    sectionTitle,
    trashMode = false
  }: {
    message?: MailMessage | null;
    deliveryDetail?: DeliveryDetail | null;
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
    onManageLabels?: (message: MailMessage) => void;
    onToggleRead?: (message: MailMessage) => void | Promise<void>;
    onArchive?: (message: MailMessage) => void | Promise<void>;
    onRemove?: (message: MailMessage) => void | Promise<void>;
    onRestore?: (message: MailMessage) => void | Promise<void>;
    onPermanentDelete?: (message: MailMessage) => void | Promise<void>;
    onReloadInboundDetail?: (message: MailMessage) => void | Promise<void>;
    onReloadDeliveryDetail?: (message: MailMessage) => void | Promise<void>;
    onRetryDelivery?: (message: MailMessage) => void | Promise<void>;
    onOpenReader?: (message: MailMessage) => void;
    onCloseReader?: () => void;
    standaloneHref?: string | null;
    sectionTitle?: string;
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
  const additionalRecipientCount = $derived.by(() => {
    if (!message || (message.folder !== 'sent' && message.folder !== 'drafts')) return 0;
    const to = message.toAddresses?.length ?? parseAddressList(message.toEmail).length;
    const cc = message.ccAddresses?.length ?? parseAddressList(message.cc ?? '').length;
    const bcc = message.bccAddresses?.length ?? parseAddressList(message.bcc ?? '').length;
    return Math.max(0, to + cc + bcc - 1);
  });
  const downloadHref = $derived(safeHref(rawDownloadHref));
  const deliveryStatus = $derived(message?.folder === 'sent' ? (message.deliveryStatus ?? 'submitted') : null);

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
  const hasPrimaryActions = $derived(Boolean(message && (trashMode
    ? onRestore || onPermanentDelete
    : message.folder !== 'drafts' && (onReply || onReplyAll || onForward || onToggleRead))));
  const folderTitle = $derived(sectionTitle || (trashMode ? t('shell.trash')
    : message?.folder === 'drafts' ? t('shell.drafts')
      : message?.folder === 'sent' ? t('shell.sent')
        : message?.archivedAt ? t('shell.archive') : t('shell.inbox')));
  const longSubject = $derived((message?.subject ?? '').length > 88);
</script>

{#if message}
  {#snippet primaryActions(mobile: boolean)}
    {#if hasPrimaryActions}
      <nav class:message-primary-actions-mobile={mobile} class:message-primary-actions-desktop={!mobile} class="message-primary-actions flex shrink-0 items-center gap-1" aria-label={t('mail.actions')}>
        {#if trashMode}
          {#if onRestore}<IconButton ariaLabel={t('mail.restore')} title={t('mail.restore')} variant="primary" size="sm" onclick={() => onRestore?.(message)} disabled={pending}><RotateCcw class="size-4" aria-hidden="true" /><span class="fm-mobile-action-label">{t('mail.restore')}</span></IconButton>{/if}
          {#if onPermanentDelete}<IconButton ariaLabel={t('mail.permanentDelete')} title={t('mail.permanentDelete')} variant="danger" size="sm" onclick={() => (removeConfirmOpen = true)} disabled={pending}><Trash2 class="size-4" aria-hidden="true" /><span class="fm-mobile-action-label">{t('mail.permanentDelete')}</span></IconButton>{/if}
        {:else if message.folder !== 'drafts'}
          {#if onReply}<IconButton ariaLabel={t('mail.reply')} title={t('mail.reply')} variant="primary" size="sm" onclick={() => onReply?.(message)} disabled={pending}><Reply class="size-4" aria-hidden="true" /><span class="fm-mobile-action-label">{t('mail.reply')}</span></IconButton>{/if}
          {#if onReplyAll}
            <IconButton ariaLabel={t('mail.replyAll')} title={t('mail.replyAll')} variant="outline" size="sm" onclick={() => onReplyAll?.(message)} disabled={pending}><ReplyAll class="size-4" aria-hidden="true" /><span class="fm-mobile-action-label">{t('mail.replyAll')}</span></IconButton>
          {/if}
        {/if}
        {#if !trashMode}
          {#if message.folder !== 'drafts' && onForward}
            <IconButton ariaLabel={t('mail.forward')} title={t('mail.forward')} variant="outline" size="sm" onclick={() => onForward?.(message)} disabled={pending}><Forward class="size-4" aria-hidden="true" /><span class="fm-mobile-action-label">{t('mail.forward')}</span></IconButton>
          {/if}
          {#if message.folder !== 'drafts' && onToggleRead}
            <IconButton ariaLabel={message.read ? t('mail.markUnread') : t('mail.markRead')} title={message.read ? t('mail.markUnread') : t('mail.markRead')} size="sm" containerClass="sm:!hidden" class="sm:!hidden" onclick={() => onToggleRead?.(message)} disabled={pending}><Mail class="size-4" aria-hidden="true" /><span class="fm-mobile-action-label">{message.read ? t('mail.markUnread') : t('mail.markRead')}</span></IconButton>
          {/if}
        {/if}
      </nav>
    {/if}
  {/snippet}
  <header class="message-detail-header flex-none border-b border-[var(--fm-border)] bg-[var(--fm-surface)]">
    <div class="message-header-row flex min-h-12 items-center gap-1 border-b border-[var(--fm-border)] px-3 py-1 sm:px-5">
      {#if showBack}
        <IconButton ariaLabel={t('mail.backToList')} title={t('mail.backToList')} size="sm" tooltipSide="right" containerClass="fm-detail-back" class="shrink-0" onclick={() => onBack?.()}>
          <ArrowLeft class="size-4" aria-hidden="true" />
        </IconButton>
      {/if}
      {#if showBack}<span class="mobile-folder-label">{folderTitle}</span>{/if}
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
          <IconButton id="fm-open-reader-trigger" ariaLabel={t('mail.openReader')} title={t('mail.openReader')} size="sm" containerClass="!hidden sm:!inline-flex" class="hidden sm:inline-flex" onclick={() => onOpenReader?.(message)}>
            <Maximize2 class="size-4" aria-hidden="true" />
          </IconButton>
          {#if standaloneHref}
            <a class="fm-touch-target hidden size-8 place-items-center rounded-[var(--radius-md)] text-[var(--fm-text-muted)] hover:bg-[var(--fm-surface-hover)] hover:text-[var(--fm-text)] sm:grid" href={standaloneHref} target="_blank" rel="noopener noreferrer" aria-label={t('mail.openNewWindow')} title={t('mail.openNewWindow')}>
              <ArrowUpRight class="size-4" aria-hidden="true" />
            </a>
          {/if}
        {/if}
        {#if !trashMode && message.folder === 'inbox' && onArchive}
          <IconButton ariaLabel={message.archivedAt ? t('mail.moveToInbox') : t('shell.archive')} title={message.archivedAt ? t('mail.moveToInbox') : t('shell.archive')} size="sm" onclick={() => onArchive?.(message)} disabled={pending}>
            {#if message.archivedAt}<Inbox class="size-4" aria-hidden="true" />{:else}<Archive class="size-4" aria-hidden="true" />{/if}
          </IconButton>
        {/if}
        {#if !trashMode && onToggleStar}
          <IconButton ariaLabel={message.starred ? t('mail.unstar') : t('mail.star')} title={message.starred ? t('mail.unstar') : t('mail.star')} size="sm" ariaPressed={message.starred} class="text-[var(--fm-text-muted)]" onclick={() => onToggleStar?.(message)} disabled={pending}>
            <Star class="size-4" fill={message.starred ? 'var(--fm-brand-orange)' : 'none'} color={message.starred ? 'var(--fm-brand-orange-strong)' : 'currentColor'} aria-hidden="true" />
          </IconButton>
        {/if}
        {#if !trashMode && onManageLabels}
          <IconButton ariaLabel={t('label.apply')} title={t('label.apply')} size="sm" onclick={() => onManageLabels?.(message)} disabled={pending}>
            <Tag class="size-4" aria-hidden="true" />
          </IconButton>
        {/if}
        {#if !trashMode && onToggleRead}
          <IconButton ariaLabel={message.read ? t('mail.markUnread') : t('mail.markRead')} title={message.read ? t('mail.markUnread') : t('mail.markRead')} size="sm" containerClass="!hidden sm:!inline-flex" class="hidden text-[var(--fm-text-muted)] sm:inline-flex" onclick={() => onToggleRead?.(message)} disabled={pending}>
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
      {@render primaryActions(false)}
    </div>

    <div class="message-sender px-4 pb-3 pt-2 sm:px-5 sm:pb-3 sm:pt-3">
      <div class="flex items-start gap-3">
        <Avatar name={senderName || senderEmail || '?'} size="lg" />
        <div class="min-w-0 flex-1">
          <div class="message-sender-identity flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span class="min-w-0 max-w-full break-words font-medium text-[var(--fm-text)]">
              {#if message.folder === 'sent' || message.folder === 'drafts'}
                <span class="text-[11px] text-[var(--fm-text-muted)]">{t('mail.to')}:</span>
              {/if}
              {senderName || senderEmail || t('mail.unknownContact')}
              {#if additionalRecipientCount > 0}
                <span class="ml-1 text-xs font-normal text-[var(--fm-text-muted)]">{translateCount(i18n.locale, 'mail.moreRecipients', additionalRecipientCount)}</span>
              {/if}
            </span>
            <span class="block max-w-full truncate text-xs text-[var(--fm-text-secondary)]">&lt;{senderEmail || t('mail.unknownAddress')}&gt;</span>
          </div>
          {#if (message.folder === 'sent' || message.folder === 'drafts') && message.fromEmail}
            <p class="message-outbound-identity mt-1 min-w-0 text-xs leading-5 text-[var(--fm-text-secondary)]"><span class="font-medium">{t('mail.from')}:</span> <span class="break-all">{message.fromEmail}</span></p>
          {/if}
        </div>
        <time class="shrink-0 text-right text-xs text-[var(--fm-text-muted)]" datetime={message.sentAt} title={formatDate(message.sentAt)}>{formatCompactDate(message.sentAt)}</time>
      </div>

      {#if message.folder === 'sent' && deliveryStatus}
        <div class="mt-2 sm:hidden"><StatusBadge status={deliveryStatus} tone={deliveryTone(deliveryStatus)}>{deliveryLabel(deliveryStatus)}</StatusBadge></div>
      {/if}
    </div>
    {@render primaryActions(true)}
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
  .fm-mobile-action-label { display: none; }
  .mobile-folder-label { display: none; }
  .message-primary-actions-mobile { display: none; }

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
    padding: 0 0.375rem;
    color: var(--fm-primary);
    font-size: 12px;
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

  @media (max-width: 639px) {
    .message-detail-header { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; }
    .message-header-row { display: contents; }
    :global(.fm-detail-back) { grid-column: 1; grid-row: 1; align-self: center; justify-self: start; margin-left: var(--space-2); }
    .mobile-folder-label { display: block; grid-column: 2; grid-row: 1; align-self: center; min-width: 0; overflow: hidden; font-size: 0.875rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .message-header-tools { grid-column: 3; grid-row: 1; min-height: 52px; justify-self: end; padding-right: var(--space-2); }
    .message-subject { grid-column: 1 / -1; grid-row: 2; border-top: 1px solid var(--fm-border); padding: var(--space-4) var(--space-4) var(--space-2); }
    .message-subject h1 { font-size: 1.25rem; line-height: 1.35; }
    .message-sender { grid-column: 1 / -1; grid-row: 3; padding: var(--space-2) var(--space-4) var(--space-4); }
    .message-sender-identity { flex-direction: column; align-items: flex-start; }
    .message-primary-actions { grid-column: 1 / -1; grid-row: 4; display: flex; width: 100%; gap: 0; border-top: 1px solid var(--fm-border); padding: var(--space-1) var(--space-4); }
    .message-primary-actions-desktop { display: none; }
    :global(.message-primary-actions > span) { display: flex; flex: 1 1 0; min-width: 0; }
    :global(.message-primary-actions > span + span) { border-left: 1px solid var(--fm-border); }
    :global(.message-primary-actions > span > button) { display: flex; width: 100%; min-height: 60px; flex-direction: column; gap: var(--space-1); border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--fm-primary); aspect-ratio: auto; }
    :global(.message-primary-actions > span > button:hover) { background: var(--fm-primary-soft); }
    .fm-mobile-action-label { display: block; font-size: 0.75rem; line-height: 1rem; white-space: nowrap; }
    :global(.message-primary-actions svg) { width: 20px; height: 20px; }
  }
</style>
