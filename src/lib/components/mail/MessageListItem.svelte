<script lang="ts">
  import {
    AlertCircle,
    Ban,
    CheckCircle2,
    ChevronRight,
    Clock3,
    FileText,
    Mail,
    Paperclip,
    Star,
    XCircle
  } from '@lucide/svelte';
  import { StatusBadge } from '$lib/components/ui';
  import { formatNumber } from '$lib/i18n';
  import type { MailboxSection, MailMessage, MailThread } from '$lib/domain/mail';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  type AppSection = MailboxSection | 'trash' | 'profile';

  let {
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

  const counterpart = $derived(
    thread?.counterpartLabel ||
      (isDraft || itemMessage?.folder === 'sent'
        ? itemMessage?.toName || itemMessage?.toEmail || t('mail.recipientMissing')
        : itemMessage?.fromName || itemMessage?.fromEmail || t('mail.unknownSender'))
  );

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
    class={`group relative flex min-h-[72px] cursor-pointer items-center border-b border-[var(--fm-border)] bg-[var(--fm-surface)] text-left transition-colors hover:bg-[var(--fm-surface-hover)] ${selected ? 'bg-[var(--fm-surface-selected)]' : ''}`}
    role="listitem"
  >
    {#if selected}<span class="absolute inset-y-0 left-0 w-[3px] bg-[var(--fm-brand-orange)]" aria-hidden="true"></span>{/if}
    {#if selectable}
      <label class="grid min-h-11 min-w-11 shrink-0 place-items-center">
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
      class="flex min-h-[72px] min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fm-focus)]"
      aria-current={selected ? 'true' : undefined}
      aria-label={`${isUnread ? t('mail.unreadPrefix') : ''}${counterpart}, ${itemSubject}${itemCount > 1 ? `, ${t('mail.threadCount', { count: formattedItemCount })}` : ''}`}
      onclick={handleSelect}
    >
      <span class="grid size-2 shrink-0 place-items-center" aria-hidden="true">
        {#if isUnread}<span class="size-2 rounded-full bg-[var(--fm-primary)]"></span>{/if}
      </span>
      <span class="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--fm-primary-soft)] text-xs font-semibold text-[var(--fm-primary)]">
        {#if isDraft}<FileText class="size-4" aria-hidden="true" />{:else}{counterpart.trim().slice(0, 1).toUpperCase() || '?'}{/if}
      </span>
      <span class="min-w-0 flex-1 self-stretch py-0.5">
        <span class="flex min-w-0 items-center gap-2">
          <span class={`min-w-0 flex-1 truncate text-xs ${isUnread ? 'font-bold text-[var(--fm-text)]' : 'font-medium text-[var(--fm-text-secondary)]'}`}>{counterpart}</span>
          <time class="shrink-0 text-[11px] tabular-nums text-[var(--fm-text-muted)]" datetime={itemMessage.sentAt}>{formatDate(thread?.sentAt || itemMessage.sentAt)}</time>
        </span>
        <span class={`mt-0.5 flex min-w-0 items-center gap-1 text-sm leading-5 ${isUnread ? 'font-semibold text-[var(--fm-text)]' : 'font-medium text-[var(--fm-text-secondary)]'}`}>
          <span class="truncate">{itemSubject}</span>
          {#if itemCount > 1}<span class="shrink-0 text-[11px] font-medium text-[var(--fm-text-muted)]">({formattedItemCount})</span>{/if}
        </span>
        <span class="mt-0.5 flex min-w-0 items-center gap-1 text-xs leading-4 text-[var(--fm-text-muted)]">
          {#if isDraft}<span class="shrink-0 font-medium text-[var(--fm-brand-orange-strong)]">{t('mail.draft')}</span>{/if}
          {#if itemMessage.labels.includes('attachment')}<Paperclip class="size-3 shrink-0" aria-label={t('mail.hasAttachment')} />{/if}
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
        {#if itemMessage.source === 'inbound'}<Mail class="hidden size-3.5 text-[var(--fm-text-muted)] sm:block" aria-hidden="true" />{/if}
      </span>
    </button>
    {#if activeSection !== 'trash'}
      <button
        type="button"
        class="mr-1 grid min-h-11 min-w-11 shrink-0 place-items-center rounded-[var(--radius-md)] text-[var(--fm-text-muted)] transition-colors hover:bg-[var(--fm-surface)] hover:text-[var(--fm-brand-orange)] focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-[var(--fm-focus)]/40"
        aria-label={isStarred ? t('mail.unstar') : t('mail.star')}
        aria-pressed={isStarred}
        title={isStarred ? t('mail.unstar') : t('mail.star')}
        onclick={handleStar}
      >
        <Star class={`size-4 ${isStarred ? 'fill-[var(--fm-brand-orange)] text-[var(--fm-brand-orange)]' : ''}`} aria-hidden="true" />
      </button>
    {/if}
    <ChevronRight class="mr-2 hidden size-4 shrink-0 text-[var(--fm-text-muted)] sm:block" aria-hidden="true" />
  </article>
{:else}
  <div class="min-h-[72px] border-b border-[var(--fm-border)]" aria-hidden="true"></div>
{/if}
