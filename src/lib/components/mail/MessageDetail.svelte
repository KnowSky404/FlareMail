<script lang="ts">
  import { Inbox } from '@lucide/svelte';
  import type { DeliveryDetail, InboundMessageDetail, MailMessage } from '$lib/domain/mail';
  import { EmptyState } from '$lib/components/ui';
  import AttachmentList from './AttachmentList.svelte';
  import DeliveryTimeline from './DeliveryTimeline.svelte';
  import MessageBody from './MessageBody.svelte';
  import MessageHeader from './MessageHeader.svelte';

  let {
    message = null,
    threadMessages = [],
    inboundDetail = null,
    inboundDetailError = '',
    inboundDetailPending = false,
    rawDownloadHref = null,
    deliveryDetail = null,
    deliveryDetailError = '',
    deliveryDetailPending = false,
    workspaceBody = null,
    workspaceBodyError = '',
    workspaceBodyPending = false,
    pending = false,
    onEditDraft,
    onReply,
    onReplyAll,
    onForward,
    onToggleStar,
    onToggleRead,
    onRemove,
    onRestore,
    onPermanentDelete,
    onReloadInboundDetail,
    onReloadDeliveryDetail,
    onRetryDelivery,
    onSelectThreadMessage,
    onBack,
    showBack = false,
    trashMode = false
  }: {
    message?: MailMessage | null;
    threadMessages?: MailMessage[];
    inboundDetail?: InboundMessageDetail | null;
    inboundDetailError?: string;
    inboundDetailPending?: boolean;
    rawDownloadHref?: string | null;
    deliveryDetail?: DeliveryDetail | null;
    deliveryDetailError?: string;
    deliveryDetailPending?: boolean;
    workspaceBody?: string | null;
    workspaceBodyError?: string;
    workspaceBodyPending?: boolean;
    pending?: boolean;
    onEditDraft?: (message: MailMessage) => void | Promise<void>;
    onReply?: (message: MailMessage) => void;
    onReplyAll?: (message: MailMessage) => void;
    onForward?: (message: MailMessage) => void;
    onToggleStar?: (message: MailMessage) => void | Promise<void>;
    onToggleRead?: (message: MailMessage) => void | Promise<void>;
    onRemove?: (message: MailMessage) => void | Promise<void>;
    onRestore?: (message: MailMessage) => void | Promise<void>;
    onPermanentDelete?: (message: MailMessage) => void | Promise<void>;
    onReloadInboundDetail?: (message: MailMessage) => void | Promise<void>;
    onReloadDeliveryDetail?: (message: MailMessage) => void | Promise<void>;
    onRetryDelivery?: (message: MailMessage) => void | Promise<void>;
    onSelectThreadMessage?: (message: MailMessage) => void | Promise<void>;
    onBack?: () => void;
    showBack?: boolean;
    trashMode?: boolean;
  } = $props();

  const visibleBody = $derived(
    message
      ? message.source === 'inbound'
        ? inboundDetail?.body ?? message.body
        : workspaceBody ?? message.body
      : ''
  );
  const hasHtml = $derived(Boolean(inboundDetail?.hasHtml));
  const threadCount = $derived(threadMessages.length);
  const isInbound = $derived(message?.source === 'inbound');
  const isSent = $derived(message?.folder === 'sent');

  const folderLabel = (folder: MailMessage['folder']) => {
    if (folder === 'inbox') return '收件箱';
    if (folder === 'sent') return '已发送';
    return '草稿箱';
  };
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col bg-[var(--fm-surface)]">
  <MessageHeader
    {message}
    {deliveryDetail}
    {inboundDetail}
    {rawDownloadHref}
    {pending}
    {inboundDetailPending}
    {deliveryDetailPending}
    {showBack}
    {onBack}
    {onEditDraft}
    {onForward}
    {onReply}
    {onReplyAll}
    {onToggleStar}
    {onToggleRead}
    {onRemove}
    {onRestore}
    {onPermanentDelete}
    {trashMode}
    {onReloadInboundDetail}
    {onReloadDeliveryDetail}
    {onRetryDelivery}
  />

  {#if message}
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <article class="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8 sm:py-8 lg:px-12" aria-label="邮件正文详情">
        {#if inboundDetailError || deliveryDetailError || workspaceBodyError}
          <div class="mb-5 grid gap-2" aria-live="polite">
            {#if inboundDetailError}<p class="rounded-[var(--radius-md)] border border-[var(--fm-danger)]/35 bg-[var(--fm-danger-soft)] px-3 py-2 text-xs text-[var(--fm-danger)]" role="alert">正文载入失败：{inboundDetailError}</p>{/if}
            {#if workspaceBodyError}<p class="rounded-[var(--radius-md)] border border-[var(--fm-danger)]/35 bg-[var(--fm-danger-soft)] px-3 py-2 text-xs text-[var(--fm-danger)]" role="alert">正文载入失败：{workspaceBodyError}</p>{/if}
            {#if deliveryDetailError}<p class="rounded-[var(--radius-md)] border border-[var(--fm-danger)]/35 bg-[var(--fm-danger-soft)] px-3 py-2 text-xs text-[var(--fm-danger)]" role="alert">投递回执载入失败：{deliveryDetailError}</p>{/if}
          </div>
        {/if}

        <MessageBody body={visibleBody} loading={(isInbound && inboundDetailPending && !inboundDetail) || (!isInbound && workspaceBodyPending && workspaceBody === null)} hasHtml={hasHtml} />

        {#if isInbound}
          <div class="mt-8">
            <AttachmentList attachments={inboundDetail?.attachments ?? []} loading={inboundDetailPending} error={inboundDetailError} />
          </div>
        {/if}

        {#if isSent && !trashMode}
          <div class="mt-8">
            <DeliveryTimeline message={message} {deliveryDetail} loading={deliveryDetailPending} error={deliveryDetailError} {pending} onReload={onReloadDeliveryDetail} onRetry={onRetryDelivery} />
          </div>
        {/if}

        {#if threadCount > 1}
          <section class="mt-8 border-t border-[var(--fm-border)] pt-6" aria-labelledby="thread-title">
            <h2 id="thread-title" class="text-sm font-semibold text-[var(--fm-text)]">线程记录 <span class="font-normal text-[var(--fm-text-muted)]">({threadCount})</span></h2>
            <ol class="mt-3 grid gap-1">
              {#each threadMessages as threadMessage (threadMessage.id)}
                <li>
                  <button class="flex min-h-14 w-full items-center gap-3 rounded-[var(--radius-md)] border border-transparent px-3 py-2 text-left hover:bg-[var(--fm-surface-hover)]" class:bg-[var(--fm-surface-selected)]={threadMessage.id === message.id} type="button" onclick={() => onSelectThreadMessage?.(threadMessage)} aria-current={threadMessage.id === message.id ? 'true' : undefined}>
                    <span class="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--fm-surface-subtle)] text-xs font-semibold text-[var(--fm-text-secondary)]" aria-hidden="true">{(threadMessage.fromName || threadMessage.fromEmail || '?').slice(0, 1).toUpperCase()}</span>
                    <span class="min-w-0 flex-1"><span class="block truncate text-xs font-medium text-[var(--fm-text)]">{threadMessage.preview || threadMessage.subject || '无主题'}</span><span class="mt-0.5 block text-[11px] text-[var(--fm-text-muted)]">{folderLabel(threadMessage.folder)}</span></span>
                    <time class="shrink-0 text-[11px] text-[var(--fm-text-muted)]" datetime={threadMessage.sentAt}>{new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(threadMessage.sentAt))}</time>
                  </button>
                </li>
              {/each}
            </ol>
          </section>
        {/if}
      </article>
    </div>
  {:else}
    <div class="min-h-0 flex-1 overflow-y-auto">
      <EmptyState title="选择一封邮件开始阅读" description="从左侧邮件列表选择邮件，详情会显示在这里。" class="h-full" icon={undefined}>
        {#snippet children()}<Inbox class="size-5" aria-hidden="true" />{/snippet}
      </EmptyState>
    </div>
  {/if}
</div>
