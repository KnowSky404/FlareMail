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
  import type { MailFolder, MailMessage, MailThread } from '$lib/domain/mail';

  type AppSection = MailFolder | 'profile';

  let {
    activeSection,
    message = null,
    thread = null,
    selected = false,
    onSelect,
    onToggleStar
  }: {
    activeSection: AppSection;
    message?: MailMessage | null;
    thread?: MailThread | null;
    selected?: boolean;
    onSelect?: (message: MailMessage, thread?: MailThread) => void | Promise<void>;
    onToggleStar?: (message: MailMessage, event?: MouseEvent) => void | Promise<void>;
  } = $props();

  const itemMessage = $derived(thread?.sectionLatestMessage ?? thread?.latestMessage ?? message);
  const isDraft = $derived(activeSection === 'drafts');
  const isUnread = $derived(Boolean(thread ? thread.unreadCount > 0 : itemMessage && !itemMessage.read));
  const isStarred = $derived(Boolean(itemMessage?.starred));
  const itemSubject = $derived(thread?.subject || itemMessage?.subject || '（无主题）');
  const itemPreview = $derived(thread?.preview || itemMessage?.preview || '');
  const itemCount = $derived(thread?.messageCount ?? 1);

  const counterpart = $derived(
    thread?.counterpartLabel ||
      (isDraft ? itemMessage?.toEmail || '收件人未填写' : itemMessage?.fromName || itemMessage?.fromEmail || '未知发件人')
  );

  const formatDate = (value?: string) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return '';
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    return new Intl.DateTimeFormat('zh-CN', sameDay ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'numeric', day: 'numeric' }).format(date);
  };

  const formatDelivery = (status?: MailMessage['deliveryStatus'] | null) => {
    const labels: Record<string, string> = {
      queued: '排队中',
      submitting: '提交中',
      submitted: '已提交',
      sent: '已发送',
      delivered: '已送达',
      delayed: '已延迟',
      bounced: '已退信',
      failed: '发送失败',
      complained: '收到投诉',
      suppressed: '已抑制',
      draft: '草稿'
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
    <button
      type="button"
      class="flex min-h-[72px] min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fm-focus)]"
      aria-current={selected ? 'true' : undefined}
      aria-label={`${isUnread ? '未读，' : ''}${counterpart}，${itemSubject}${itemCount > 1 ? `，${itemCount} 封邮件` : ''}`}
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
          {#if itemCount > 1}<span class="shrink-0 text-[11px] font-medium text-[var(--fm-text-muted)]">({itemCount})</span>{/if}
        </span>
        <span class="mt-0.5 flex min-w-0 items-center gap-1 text-xs leading-4 text-[var(--fm-text-muted)]">
          {#if isDraft}<span class="shrink-0 font-medium text-[var(--fm-brand-orange-strong)]">草稿</span>{/if}
          {#if itemMessage.labels.includes('attachment')}<Paperclip class="size-3 shrink-0" aria-label="含附件" />{/if}
          <span class="truncate">{isDraft && !itemMessage.toEmail ? '尚未填写收件人' : itemPreview || '暂无预览'}</span>
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
    <button
      type="button"
      class="mr-1 grid min-h-11 min-w-11 shrink-0 place-items-center rounded-[var(--radius-md)] text-[var(--fm-text-muted)] transition-colors hover:bg-[var(--fm-surface)] hover:text-[var(--fm-brand-orange)] focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-[var(--fm-focus)]/40"
      aria-label={isStarred ? '取消星标' : '加星标'}
      aria-pressed={isStarred}
      title={isStarred ? '取消星标' : '加星标'}
      onclick={handleStar}
    >
      <Star class={`size-4 ${isStarred ? 'fill-[var(--fm-brand-orange)] text-[var(--fm-brand-orange)]' : ''}`} aria-hidden="true" />
    </button>
    <ChevronRight class="mr-2 hidden size-4 shrink-0 text-[var(--fm-text-muted)] sm:block" aria-hidden="true" />
  </article>
{:else}
  <div class="min-h-[72px] border-b border-[var(--fm-border)]" aria-hidden="true"></div>
{/if}
