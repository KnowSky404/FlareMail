<script lang="ts">
  import { Inbox } from '@lucide/svelte';
  import type { DeliveryDetail, InboundMessageDetail, MailAttachmentSummary, MailMessage } from '$lib/domain/mail';
  import { EmptyState } from '$lib/components/ui';
  import AttachmentList from './AttachmentList.svelte';
  import DeliveryTimeline from './DeliveryTimeline.svelte';
  import MessageBody from './MessageBody.svelte';
  import MessageHeader from './MessageHeader.svelte';
  import { formatNumber } from '$lib/i18n';
  import { useLocale } from '$lib/i18n/runtime.svelte';

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
    workspaceAttachments = [],
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
    onReportHtmlIssue,
    onReloadInboundDetail,
    onReloadDeliveryDetail,
    onRetryDelivery,
    onOpenReader,
    onCloseReader,
    standaloneHref = null,
    onSelectThreadMessage,
    onBack,
    showBack = false,
    trashMode = false,
    readerMode = false,
    bodyView = 'text',
    allowRemoteImages = false,
    onBodyViewChange,
    onRemoteImagesChange
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
    workspaceAttachments?: MailAttachmentSummary[];
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
    onReportHtmlIssue?: (message: MailMessage) => void;
    onReloadInboundDetail?: (message: MailMessage) => void | Promise<void>;
    onReloadDeliveryDetail?: (message: MailMessage) => void | Promise<void>;
    onRetryDelivery?: (message: MailMessage) => void | Promise<void>;
    onOpenReader?: (message: MailMessage) => void;
    onCloseReader?: () => void;
    standaloneHref?: string | null;
    onSelectThreadMessage?: (message: MailMessage) => void | Promise<void>;
    onBack?: () => void;
    showBack?: boolean;
    trashMode?: boolean;
    readerMode?: boolean;
    bodyView?: 'text' | 'html';
    allowRemoteImages?: boolean;
    onBodyViewChange?: (view: 'text' | 'html') => void;
    onRemoteImagesChange?: (allowed: boolean) => void;
  } = $props();

  const i18n = useLocale();
  const { t } = i18n;

  const visibleBody = $derived(
    message
      ? message.source === 'inbound'
        ? inboundDetail?.body ?? message.body
        : workspaceBody ?? message.body
      : ''
  );
  const hasHtml = $derived(Boolean(inboundDetail?.hasHtml));
  const threadCount = $derived(threadMessages.length);
  const formattedThreadCount = $derived(formatNumber(threadCount, i18n.locale));
  const isInbound = $derived(message?.source === 'inbound');
  const isSent = $derived(message?.folder === 'sent');

  const folderLabel = (folder: MailMessage['folder']) => {
    if (folder === 'inbox') return t('shell.inbox');
    if (folder === 'sent') return t('shell.sent');
    return t('shell.drafts');
  };
</script>

<div class:fm-reader-body={readerMode} class="fm-detail-shell flex h-full min-h-0 min-w-0 flex-col bg-[var(--fm-surface)]">
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
    {onOpenReader}
    {onCloseReader}
    {standaloneHref}
  />

  {#if message}
    <div class="fm-detail-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <article class="mx-auto min-w-0 w-full max-w-none px-4 py-4 sm:px-6 sm:py-5 lg:px-8" aria-label={t('mail.bodyDetail')}>
        {#if inboundDetailError || deliveryDetailError || workspaceBodyError}
          <div class="mb-5 grid gap-2" aria-live="polite">
            {#if inboundDetailError}<p class="rounded-[var(--radius-md)] border border-[var(--fm-danger)]/35 bg-[var(--fm-danger-soft)] px-3 py-2 text-xs text-[var(--fm-danger)]" role="alert">{t('mail.bodyLoadError', { error: inboundDetailError })}</p>{/if}
            {#if workspaceBodyError}<p class="rounded-[var(--radius-md)] border border-[var(--fm-danger)]/35 bg-[var(--fm-danger-soft)] px-3 py-2 text-xs text-[var(--fm-danger)]" role="alert">{t('mail.bodyLoadError', { error: workspaceBodyError })}</p>{/if}
            {#if deliveryDetailError}<p class="rounded-[var(--radius-md)] border border-[var(--fm-danger)]/35 bg-[var(--fm-danger-soft)] px-3 py-2 text-xs text-[var(--fm-danger)]" role="alert">{t('mail.deliveryLoadError', { error: deliveryDetailError })}</p>{/if}
          </div>
        {/if}

        {#key message.id}
          <MessageBody
            body={visibleBody}
            loading={(isInbound && inboundDetailPending && !inboundDetail) || (!isInbound && workspaceBodyPending && workspaceBody === null)}
            hasHtml={hasHtml}
            messageId={message.id}
            view={bodyView}
            allowRemoteImages={allowRemoteImages}
            onViewChange={onBodyViewChange}
            onRemoteImagesChange={onRemoteImagesChange}
            onReportIssue={() => onReportHtmlIssue?.(message)}
          />
        {/key}

        {#if isInbound}
          <div class="mt-6">
            <AttachmentList attachments={inboundDetail?.attachments ?? []} loading={inboundDetailPending} error={inboundDetailError} />
          </div>
        {/if}

        {#if isSent && workspaceAttachments.length > 0}
          <div class="mt-6">
            <AttachmentList attachments={workspaceAttachments} loading={workspaceBodyPending} error={workspaceBodyError} />
          </div>
        {/if}

        {#if isSent && !trashMode}
          <div class="mt-6">
            <DeliveryTimeline message={message} {deliveryDetail} loading={deliveryDetailPending} error={deliveryDetailError} {pending} onReload={onReloadDeliveryDetail} onRetry={onRetryDelivery} />
          </div>
        {/if}

        {#if threadCount > 1}
          <section class="mt-6 border-t border-[var(--fm-border)] pt-5" aria-labelledby="thread-title">
            <h2 id="thread-title" class="text-sm font-semibold text-[var(--fm-text)]">{t('mail.thread')} <span class="font-normal text-[var(--fm-text-muted)]">({formattedThreadCount})</span></h2>
            <ol class="mt-3 grid gap-1">
              {#each threadMessages as threadMessage (threadMessage.id)}
                <li>
                  <button class="fm-touch-target flex min-h-14 w-full items-center gap-3 rounded-[var(--radius-md)] border border-transparent px-3 py-2 text-left hover:bg-[var(--fm-surface-hover)]" class:bg-[var(--fm-surface-selected)]={threadMessage.id === message.id} type="button" onclick={() => onSelectThreadMessage?.(threadMessage)} aria-current={threadMessage.id === message.id ? 'true' : undefined}>
                    <span class="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--fm-surface-subtle)] text-xs font-semibold text-[var(--fm-text-secondary)]" aria-hidden="true">{(threadMessage.fromName || threadMessage.fromEmail || '?').slice(0, 1).toUpperCase()}</span>
                    <span class="min-w-0 flex-1"><span class="block truncate text-xs font-medium text-[var(--fm-text)]">{threadMessage.preview || threadMessage.subject || t('mail.noSubject')}</span><span class="mt-0.5 block text-[11px] text-[var(--fm-text-muted)]">{folderLabel(threadMessage.folder)}</span></span>
                    <time class="shrink-0 text-[11px] text-[var(--fm-text-muted)]" datetime={threadMessage.sentAt}>{new Intl.DateTimeFormat(i18n.locale, { month: 'short', day: 'numeric' }).format(new Date(threadMessage.sentAt))}</time>
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
      <EmptyState title={t('mail.selectToRead')} description={t('mail.selectFromList')} class="h-full" icon={undefined}>
        {#snippet children()}<Inbox class="size-5" aria-hidden="true" />{/snippet}
      </EmptyState>
    </div>
  {/if}
</div>

<style>
  .fm-reader-body :global(.message-html-frame) {
    min-height: clamp(18rem, 68dvh, 56rem);
  }

  .fm-detail-scroll {
    min-width: 0;
    overflow-x: clip;
  }

  .fm-reader-body :global(.message-plain-body) {
    font-size: 1rem;
  }
</style>
