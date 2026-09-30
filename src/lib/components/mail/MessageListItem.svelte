<script lang="ts">
  import {
    Archive,
    Inbox,
    Mail,
    MailOpen,
    Trash2,
    AlertCircle,
    Ban,
    CheckCircle2,
    Clock3,
    FileText,
    Paperclip,
    Star,
    XCircle
  } from '@lucide/svelte';
  import { Avatar, IconButton, StatusBadge } from '$lib/components/ui';
  import { formatNumber, translateCount } from '$lib/i18n';
  import type { MailboxSection, MailMessage, MailThread } from '$lib/domain/mail';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  type AppSection = MailboxSection | 'trash' | 'profile';

  let {
    fullWidth = false,
    pending = false,
    onArchive,
    onToggleRead,
    onRemove,
    activeSection,
    message = null,
    thread = null,
    selected = false,
    onSelect,
    onToggleStar,
    selectable = false,
    selectedForBulk = false,
    onToggleSelect
  }: {
    fullWidth?: boolean;
    pending?: boolean;
    onArchive?: (message: MailMessage) => void | Promise<void>;
    onToggleRead?: (message: MailMessage) => void | Promise<void>;
    onRemove?: (message: MailMessage) => void | Promise<void>;
    activeSection: AppSection;
    message?: MailMessage | null;
    thread?: MailThread | null;
    selected?: boolean;
    onSelect?: (message: MailMessage, thread?: MailThread) => void | Promise<void>;
    onToggleStar?: (message: MailMessage, event?: MouseEvent) => void | Promise<void>;
    selectable?: boolean;
    selectedForBulk?: boolean;
    onToggleSelect?: (message: MailMessage) => void;
  } = $props();

  const i18n = useLocale();
  const { t } = i18n;

  const itemMessage = $derived(thread?.sectionLatestMessage ?? thread?.latestMessage ?? message);
  const isDraft = $derived(itemMessage?.folder === 'drafts');
  const isUnread = $derived(Boolean(thread ? thread.unreadCount > 0 : itemMessage && !itemMessage.read));
  const isStarred = $derived(Boolean(itemMessage?.starred));
  const itemSubject = $derived(thread?.subject || itemMessage?.subject || t('mail.noSubject'));
  const itemPreview = $derived(itemMessage?.searchSnippet || thread?.preview || itemMessage?.preview || '');
  const userLabels = $derived(itemMessage?.userLabels ?? []);
  const itemCount = $derived(thread?.messageCount ?? 1);
  const formattedItemCount = $derived(formatNumber(itemCount, i18n.locale));

  const hitFieldLabels = $derived({
    all: t('mail.fullText'), from: t('mail.from'), to: t('mail.to'), cc: t('mail.cc'), subject: t('mail.subject'), label: t('mail.label'),
    state: t('mail.state'), attachment: t('mail.attachments'), date: t('mail.date'), status: t('mail.delivery')
  } as const);

  function highlightedParts(value: string) {
    const open = String.fromCharCode(57344);
    const close = String.fromCharCode(57345);
    const parts: Array<{ text: string; highlighted: boolean }> = [];
    let highlighted = false;
    for (const segment of value.split(new RegExp(`(${open}|${close})`, 'u'))) {
      if (segment === open) highlighted = true;
      else if (segment === close) highlighted = false;
      else if (segment) parts.push({ text: segment, highlighted });
    }
    return parts;
  }

  const counterpart = $derived.by(() => {
    const name = thread?.counterpartLabel ||
      (isDraft || itemMessage?.folder === 'sent'
        ? itemMessage?.toName || itemMessage?.toEmail || t('mail.recipientMissing')
        : itemMessage?.fromName || itemMessage?.fromEmail || t('mail.unknownSender'));
    return thread && thread.counterpartyCount > 1
      ? translateCount(i18n.locale, 'mail.threadCounterpart', thread.counterpartyCount - 1, { name })
      : name;
  });
  const counterpartEmail = $derived(thread?.counterpartEmail ||
    (isDraft || itemMessage?.folder === 'sent' ? itemMessage?.toEmail : itemMessage?.fromEmail) || '');
  const accessibleCounterpart = $derived(counterpartEmail && counterpart !== counterpartEmail
    ? `${counterpart} <${counterpartEmail}>`
    : counterpart);
  const starredSourceLabel = $derived(itemMessage?.folder === 'drafts' ? t('shell.drafts')
    : itemMessage?.folder === 'sent' ? t('shell.sent')
    : itemMessage?.archivedAt ? t('shell.archive') : t('shell.inbox'));

  const formatDate = (value?: string) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return '';
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    return new Intl.DateTimeFormat(i18n.locale, sameDay ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'numeric', day: 'numeric' }).format(date);
  };

  const formatDelivery = (status?: MailMessage['deliveryStatus'] | null) => {
    const labels: Record<string, string> = {
      queued: t('mail.statusQueued'),
      submitting: t('mail.statusSubmitting'),
      submitted: t('mail.statusSubmittedShort'),
      sent: t('mail.statusSent'),
      delivered: t('mail.statusDelivered'),
      delayed: t('mail.statusDelayed'),
      bounced: t('mail.statusBounced'),
      failed: t('mail.statusFailed'),
      complained: t('mail.statusComplained'),
      suppressed: t('mail.statusSuppressed'),
      draft: t('mail.statusDraft')
    };
    return status ? labels[status] || status : '';
  };
  const accessibleLabel = $derived([
    selected ? t('mail.listSelected') : '',
    isUnread ? t('mail.unread') : '',
    isStarred ? t('mail.starred') : '',
    accessibleCounterpart,
    itemSubject,
    itemCount > 1 ? translateCount(i18n.locale, 'mail.threadCount', itemCount) : '',
    activeSection === 'starred' || activeSection === 'label' ? starredSourceLabel : '',
    userLabels.length ? `${t('mail.label')}: ${userLabels.map((label) => label.name).join(', ')}` : '',
    itemMessage?.hasAttachments || itemMessage?.labels.includes('attachment') ? t('mail.hasAttachment') : '',
    activeSection === 'sent' && itemMessage?.deliveryStatus
      ? `${t('mail.delivery')}: ${formatDelivery(itemMessage.deliveryStatus)}`
      : ''
  ].filter(Boolean).join(', '));

  const deliveryIcon = (status?: MailMessage['deliveryStatus'] | null) => {
    if (status === 'delivered' || status === 'sent') return CheckCircle2;
    if (status === 'failed' || status === 'bounced' || status === 'complained') return XCircle;
    if (status === 'suppressed') return Ban;
    if (status === 'queued' || status === 'submitting' || status === 'submitted' || status === 'delayed') return Clock3;
    return AlertCircle;
  };

  const handleSelect = () => {
    if (itemMessage) void onSelect?.(itemMessage, thread || undefined);
  };

  const handleStar = (event: MouseEvent) => {
    event.stopPropagation();
    if (itemMessage) void onToggleStar?.(itemMessage, event);
  };
</script>

{#if itemMessage}
  <article
    class="mail-list-item group relative flex cursor-pointer items-center border-b border-[var(--fm-border)] bg-[var(--fm-surface)] text-left transition-colors hover:bg-[var(--fm-surface-hover)]"
    class:fm-selected={selected}
    class:wide-row={fullWidth}
    class:unread-row={isUnread}
    role="listitem"
  >
    {#if selected}<span class="absolute inset-y-0 left-0 w-[3px] bg-[var(--fm-brand-orange)]" aria-hidden="true"></span>{/if}
    {#if selectable}
      <label class="fm-touch-target grid min-h-8 min-w-8 shrink-0 place-items-center">
        <span class="sr-only">{t('mail.select', { subject: itemSubject })}</span>
        <input
          class="size-4 accent-[var(--fm-primary)]"
          type="checkbox"
          checked={selectedForBulk}
          aria-label={t('mail.select', { subject: itemSubject })}
          onclick={(event) => event.stopPropagation()}
          onchange={() => itemMessage && onToggleSelect?.(itemMessage)}
        />
      </label>
    {/if}
    <button
      type="button"
      class="mail-list-item-button flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fm-focus)]"
      aria-current={selected ? 'true' : undefined}
      aria-label={accessibleLabel}
      onclick={handleSelect}
    >
      <span class="unread-dot grid size-2 shrink-0 place-items-center" aria-hidden="true">
        {#if isUnread}<span class="size-2 rounded-full bg-[var(--fm-primary)]"></span>{/if}
      </span>
      <span class="row-avatar">
      {#if isDraft}
        <Avatar name={counterpart}><FileText class="size-4" aria-hidden="true" /></Avatar>
      {:else}
        <Avatar name={counterpart} />
      {/if}
      </span>
      <span class="row-content min-w-0 flex-1 self-stretch py-0.5">
        <span class="row-sender-line flex min-w-0 items-center gap-2">
          <span class={`min-w-0 flex-1 truncate text-[13px] ${isUnread ? 'font-bold text-[var(--fm-text)]' : 'font-medium text-[var(--fm-text-secondary)]'}`}>{counterpart}</span>
          <time class="row-date shrink-0 text-xs tabular-nums text-[var(--fm-text-muted)]" datetime={itemMessage.sentAt}>{formatDate(thread?.sentAt || itemMessage.sentAt)}</time>
        </span>
        <span class={`row-subject mt-0.5 flex min-w-0 items-center gap-1 text-[15px] leading-5 ${isUnread ? 'font-semibold text-[var(--fm-text)]' : 'font-medium text-[var(--fm-text-secondary)]'}`}>
          <span class="truncate">{itemSubject}</span>
          {#if itemCount > 1}<span class="shrink-0 text-[11px] font-medium text-[var(--fm-text-muted)]">({formattedItemCount})</span>{/if}
        </span>
        <span class="row-preview mt-0.5 flex min-w-0 items-center gap-1 text-[13px] leading-4 text-[var(--fm-text-muted)]">
          {#if activeSection === 'starred' || activeSection === 'label'}<span class="shrink-0 rounded bg-[var(--fm-surface-subtle)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--fm-text-secondary)]">{starredSourceLabel}</span>{/if}
          {#if isDraft && activeSection !== 'starred' && activeSection !== 'label'}<span class="shrink-0 font-medium text-[var(--fm-brand-orange-strong)]">{t('mail.draft')}</span>{/if}
          {#if activeSection !== 'label' && userLabels.length}
            <span class="max-w-28 shrink-0 truncate rounded bg-[var(--fm-primary-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--fm-primary)]" title={userLabels[0].name}>{userLabels[0].name}</span>
            {#if userLabels.length > 1}<span class="shrink-0 text-[10px] font-medium text-[var(--fm-text-muted)]" title={userLabels.slice(1).map((label) => label.name).join(', ')}>+{userLabels.length - 1}</span>{/if}
          {/if}
          {#if itemMessage.hasAttachments || itemMessage.labels.includes('attachment')}<Paperclip class="size-3 shrink-0" aria-label={t('mail.hasAttachment')} />{/if}
          {#if itemMessage.searchHitFields?.length}
            <span class="shrink-0 rounded bg-[var(--fm-primary-soft)] px-1 py-0.5 text-[10px] font-medium text-[var(--fm-primary)]">
              {itemMessage.searchHitFields.map((field) => hitFieldLabels[field]).join(' · ')}
            </span>
          {/if}
          <span class="truncate">
            {#if isDraft && !itemMessage.toEmail}
              {t('mail.noRecipient')}
            {:else if itemPreview}
              {#each highlightedParts(itemPreview) as part}
                {#if part.highlighted}<mark class="rounded bg-[var(--fm-warning-soft)] px-0.5 text-inherit">{part.text}</mark>{:else}{part.text}{/if}
              {/each}
            {:else}
              {t('mail.noPreview')}
            {/if}
          </span>
        </span>
      </span>
      <span class="flex shrink-0 flex-col items-end justify-center gap-1">
        {#if activeSection === 'sent' && itemMessage.deliveryStatus}
          {@const DeliveryIcon = deliveryIcon(itemMessage.deliveryStatus)}
          <span class="hidden sm:inline-flex"><StatusBadge status={formatDelivery(itemMessage.deliveryStatus)} /></span>
          <span class="inline-flex sm:hidden" title={formatDelivery(itemMessage.deliveryStatus)}><DeliveryIcon class="size-3.5 text-[var(--fm-text-muted)]" aria-hidden="true" /></span>
        {/if}
      </span>
    </button>
    {#if activeSection !== 'trash'}
      <span class="row-star">
      <IconButton
        ariaLabel={isStarred ? t('mail.unstar') : t('mail.star')}
        title={isStarred ? t('mail.unstar') : t('mail.star')}
        ariaPressed={isStarred}
        size="sm"
        tooltipSide="top"
        class="mr-1 shrink-0 text-[var(--fm-text-muted)] hover:text-[var(--fm-brand-orange-strong)]"
        disabled={pending}
        onclick={handleStar}
      >
        <Star class={`size-4 ${isStarred ? 'fill-[var(--fm-brand-orange)]' : ''}`} color={isStarred ? 'var(--fm-brand-orange-strong)' : 'currentColor'} aria-hidden="true" />
      </IconButton>
      </span>
    {/if}
    {#if activeSection !== 'trash' && (onRemove || onArchive || onToggleRead)}
      <div class="row-actions" class:draft-actions={isDraft}>
        {#if itemMessage.folder === 'inbox' && onArchive}
          <span class="row-secondary-action"><IconButton ariaLabel={itemMessage.archivedAt ? t('mail.moveToInbox') : t('shell.archive')} title={itemMessage.archivedAt ? t('mail.moveToInbox') : t('shell.archive')} size="sm" tooltipSide="top" disabled={pending} onclick={() => itemMessage && onArchive?.(itemMessage)}>
            {#if itemMessage.archivedAt}<Inbox class="size-4" aria-hidden="true" />{:else}<Archive class="size-4" aria-hidden="true" />{/if}
          </IconButton></span>
        {/if}
        {#if itemMessage.folder === 'inbox' && onToggleRead}
          <span class="row-secondary-action"><IconButton ariaLabel={itemMessage.read ? t('mail.markUnread') : t('mail.markRead')} title={itemMessage.read ? t('mail.markUnread') : t('mail.markRead')} size="sm" tooltipSide="top" disabled={pending} onclick={() => itemMessage && onToggleRead?.(itemMessage)}>
            {#if itemMessage.read}<Mail class="size-4" aria-hidden="true" />{:else}<MailOpen class="size-4" aria-hidden="true" />{/if}
          </IconButton></span>
        {/if}
        {#if onRemove}
          <IconButton ariaLabel={t('mail.moveTrash')} title={t('mail.moveTrash')} size="sm" tooltipSide="top" disabled={pending} onclick={() => itemMessage && onRemove?.(itemMessage)}><Trash2 class="size-4" aria-hidden="true" /></IconButton>
        {/if}
      </div>
    {/if}
  </article>
{:else}
  <div class="mail-list-item min-h-[76px] border-b border-[var(--fm-border)]" aria-hidden="true"></div>
{/if}

<style>
  .row-actions { display: none; align-items: center; padding-right: 4px; }
  .row-actions.draft-actions { display: flex; }
  .row-secondary-action { display: inline-flex; }
  @media (min-width: 901px) {
    .wide-row { position: relative; padding-inline: 12px 8px; }
    .mail-list-item.wide-row, .wide-row .mail-list-item-button { min-height: 52px; }
    .wide-row.unread-row { background: var(--fm-primary-soft); }
    .wide-row .row-avatar, .wide-row .unread-dot { display: none; }
    .wide-row .row-star { order: -1; }
    .wide-row > label { order: -2; }
    .wide-row .row-content { display: grid; grid-template-columns: minmax(110px, 180px) auto minmax(0, 1fr) 58px; align-items: center; gap: 12px; }
    .wide-row .row-sender-line { display: contents; }
    .wide-row .row-sender-line > span { grid-column: 1; font-size: 13px; }
    .wide-row .row-date { grid-column: 4; grid-row: 1; text-align: right; }
    .wide-row .row-subject { grid-column: 2; grid-row: 1; max-width: min(26vw, 350px); font-size: 13px; margin-top: 0; }
    .wide-row .row-preview { grid-column: 3; grid-row: 1; margin-top: 0; }
    .wide-row .row-actions { display: flex; position: absolute; right: 8px; background: var(--fm-surface-hover); opacity: 0; pointer-events: none; }
    .wide-row:hover .row-actions, .wide-row:focus-within .row-actions { opacity: 1; pointer-events: auto; }
    .wide-row:hover, .wide-row:focus-within { background: var(--fm-surface-hover); }
    .wide-row .row-actions.draft-actions { position: static; opacity: 1; pointer-events: auto; background: transparent; }
  }
  @media (max-width: 900px) { .row-actions.draft-actions .row-secondary-action { display: none; } }

  .mail-list-item.fm-selected,
  .mail-list-item.fm-selected:hover {
    background: var(--fm-surface-selected);
  }

  .mail-list-item,
  .mail-list-item-button {
    min-height: 76px;
  }

  @media (min-width: 901px) {
    .mail-list-item,
    .mail-list-item-button {
      min-height: 88px;
    }
  }
</style>
