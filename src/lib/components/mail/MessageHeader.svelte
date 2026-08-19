<script lang="ts">
  import {
    Archive,
    ArrowLeft,
    ArrowUpRight,
    ChevronDown,
    Forward,
    Mail,
    MoreHorizontal,
    Reply,
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
    onToggleStar,
    onToggleRead,
    onRemove,
    onReloadInboundDetail,
    onReloadDeliveryDetail,
    onRetryDelivery
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
    onEditDraft?: (message: MailMessage) => void;
    onForward?: (message: MailMessage) => void;
    onReply?: (message: MailMessage) => void;
    onToggleStar?: (message: MailMessage) => void | Promise<void>;
    onToggleRead?: (message: MailMessage) => void | Promise<void>;
    onRemove?: (message: MailMessage) => void | Promise<void>;
    onReloadInboundDetail?: (message: MailMessage) => void | Promise<void>;
    onReloadDeliveryDetail?: (message: MailMessage) => void | Promise<void>;
    onRetryDelivery?: (message: MailMessage) => void | Promise<void>;
  } = $props();

  let removeConfirmOpen = $state(false);
  let actionsMenuOpen = $state(false);

  const formatDate = (value: string) =>
    new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));

  const formatBytes = (value: number) => {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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
  const counterpartLabel = $derived(message?.folder === 'inbox' ? '发件人' : '收件人');
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

  const deliveryLabel = (status: string | null) => {
    const labels: Record<string, string> = {
      draft: '草稿',
      queued: '排队中',
      submitting: '提交中',
      submitted: '已提交至 Resend',
      sent: '已发送',
      delivered: '已送达',
      delayed: '投递延迟',
      bounced: '已退信',
      failed: '发送失败',
      complained: '收到投诉',
      suppressed: '已抑制'
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
</script>

{#if message}
  <header class="flex-none border-b border-[var(--fm-border)] bg-[var(--fm-surface)]">
    <div class="flex min-h-14 items-center gap-1 border-b border-[var(--fm-border)] px-3 sm:px-5">
      {#if showBack}
        <button
          class="grid size-11 shrink-0 place-items-center rounded-[var(--radius-md)] text-[var(--fm-text-secondary)] hover:bg-[var(--fm-surface-hover)] hover:text-[var(--fm-text)] xl:hidden"
          aria-label="返回邮件列表"
          title="返回邮件列表"
          type="button"
          onclick={() => onBack?.()}
        >
          <ArrowLeft class="size-5" aria-hidden="true" />
        </button>
      {/if}
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <h1 class="truncate text-base font-semibold text-[var(--fm-text)] sm:text-lg">{message.subject || '无主题'}</h1>
          {#if message.folder === 'sent' && deliveryStatus}
            <StatusBadge status={deliveryStatus} tone={deliveryTone(deliveryStatus)} class="hidden shrink-0 sm:inline-flex">
              {deliveryLabel(deliveryStatus)}
            </StatusBadge>
          {/if}
        </div>
        <p class="truncate text-xs text-[var(--fm-text-muted)]">{message.preview || '无预览'}</p>
      </div>
      <div class="flex shrink-0 items-center gap-0.5">
        <button
          class="grid size-11 place-items-center rounded-[var(--radius-md)] hover:bg-[var(--fm-surface-hover)]"
          class:text-[var(--fm-brand-orange)]={message.starred}
          class:text-[var(--fm-text-muted)]={!message.starred}
          aria-label={message.starred ? '取消星标' : '加星'}
          title={message.starred ? '取消星标' : '加星'}
          type="button"
          onclick={() => onToggleStar?.(message)}
          disabled={pending}
        >
          <Star class="size-[18px]" fill={message.starred ? 'currentColor' : 'none'} aria-hidden="true" />
        </button>
        <button
          class="hidden size-11 place-items-center rounded-[var(--radius-md)] text-[var(--fm-text-muted)] hover:bg-[var(--fm-surface-hover)] hover:text-[var(--fm-text)] sm:grid"
          aria-label={message.read ? '标为未读' : '标为已读'}
          title={message.read ? '标为未读' : '标为已读'}
          type="button"
          onclick={() => onToggleRead?.(message)}
          disabled={pending}
        >
          <Mail class="size-[18px]" aria-hidden="true" />
        </button>
        <DropdownMenu
          open={actionsMenuOpen}
          align="end"
          class="message-actions-menu"
          onOpenChange={(open) => (actionsMenuOpen = open)}
        >
          {#snippet trigger()}
            <MoreHorizontal class="size-[18px]" aria-hidden="true" />
            <span class="sr-only">更多邮件操作</span>
          {/snippet}
          {#snippet children()}
            {#if message.folder === 'drafts'}
              <button class="menu-action" role="menuitem" type="button" onclick={() => onEditDraft?.(message)}><Archive class="size-4" aria-hidden="true" />继续编辑草稿</button>
            {/if}
            {#if message.folder === 'inbox'}
              <button class="menu-action" role="menuitem" type="button" onclick={() => onToggleRead?.(message)}><Mail class="size-4" aria-hidden="true" />{message.read ? '标为未读' : '标为已读'}</button>
            {/if}
            <button class="menu-action text-[var(--fm-danger)]" role="menuitem" type="button" onclick={() => (removeConfirmOpen = true)}><Trash2 class="size-4" aria-hidden="true" />{message.folder === 'drafts' ? '删除草稿' : '删除邮件'}</button>
          {/snippet}
        </DropdownMenu>
      </div>
    </div>

    <div class="px-4 pb-4 pt-3 sm:px-8 sm:pb-5 sm:pt-4">
      <div class="flex items-start gap-3">
        <div class="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--fm-primary-soft)] text-sm font-semibold text-[var(--fm-primary)]" aria-hidden="true">
          {(senderName || senderEmail || '?').slice(0, 1).toUpperCase()}
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span class="font-medium text-[var(--fm-text)]">{senderName || senderEmail || '未知联系人'}</span>
            <span class="truncate text-xs text-[var(--fm-text-secondary)]">&lt;{senderEmail || '未知地址'}&gt;</span>
          </div>
          <details class="mt-1 text-xs text-[var(--fm-text-muted)]">
            <summary class="inline-flex cursor-pointer list-none items-center gap-1 hover:text-[var(--fm-text)]">
              <span>{counterpartLabel}详情</span><ChevronDown class="size-3" aria-hidden="true" />
            </summary>
            <dl class="mt-2 grid max-w-xl grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-[var(--radius-md)] bg-[var(--fm-surface-subtle)] p-3 leading-5">
              <dt>发件人</dt><dd class="truncate text-[var(--fm-text-secondary)]">{message.fromName} &lt;{message.fromEmail}&gt;</dd>
              <dt>收件人</dt><dd class="break-words text-[var(--fm-text-secondary)]">{toSummary}</dd>
              {#if ccSummary}<dt>抄送</dt><dd class="break-words text-[var(--fm-text-secondary)]">{ccSummary}</dd>{/if}
              {#if bccSummary}<dt>密送</dt><dd class="break-words text-[var(--fm-text-secondary)]">{bccSummary}</dd>{/if}
              {#if message.messageId}<dt>Message-ID</dt><dd class="truncate font-mono text-[var(--fm-text-secondary)]">{message.messageId}</dd>{/if}
            </dl>
          </details>
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
          <span class="text-xs text-[var(--fm-text-muted)]">{inboundDetail.attachments.length} 个附件 · {formatBytes(inboundDetail.rawSize)}</span>
        {/if}
      </div>

      <nav class="mt-4 flex flex-wrap items-center gap-2" aria-label="邮件操作">
        {#if message.folder === 'inbox'}
          <button class="action-button action-button-primary" type="button" onclick={() => onReply?.(message)} disabled={pending}><Reply class="size-4" aria-hidden="true" />回复</button>
        {/if}
        {#if message.folder !== 'drafts'}
          <button class="action-button" type="button" onclick={() => onForward?.(message)} disabled={pending}><Forward class="size-4" aria-hidden="true" />转发</button>
        {/if}
        {#if message.source === 'inbound'}
          <button class="action-button" type="button" onclick={() => onReloadInboundDetail?.(message)} disabled={pending || inboundDetailPending}><RotateCcw class="size-4" aria-hidden="true" />{inboundDetailPending ? '刷新正文中' : '刷新正文'}</button>
        {/if}
        {#if message.folder === 'sent'}
          <button class="action-button" type="button" onclick={() => onReloadDeliveryDetail?.(message)} disabled={pending || deliveryDetailPending}><RotateCcw class="size-4" aria-hidden="true" />{deliveryDetailPending ? '刷新回执中' : '刷新回执'}</button>
          {#if canRetry}<button class="action-button" type="button" onclick={() => onRetryDelivery?.(message)} disabled={pending}><RotateCcw class="size-4" aria-hidden="true" />重试发送</button>{/if}
        {/if}
        {#if downloadHref}
          <a class="action-button" href={downloadHref} download rel="noopener noreferrer"><ArrowUpRight class="size-4" aria-hidden="true" />下载原始邮件</a>
        {/if}
      </nav>
    </div>
  </header>
{:else}
  <header class="flex-none border-b border-[var(--fm-border)] px-5 py-4"><h1 class="text-base font-semibold text-[var(--fm-text)]">邮件详情</h1></header>
{/if}

{#if message}
  <ConfirmDialog
    open={removeConfirmOpen}
    title={message.folder === 'drafts' ? '删除草稿？' : '删除邮件？'}
    description={message.folder === 'drafts' ? '草稿删除后无法恢复。' : '这封邮件会从当前文件夹移除，且无法恢复。'}
    confirmLabel={message.folder === 'drafts' ? '删除草稿' : '删除邮件'}
    {pending}
    onCancel={() => (removeConfirmOpen = false)}
    onConfirm={async () => {
      await onRemove?.(message);
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
