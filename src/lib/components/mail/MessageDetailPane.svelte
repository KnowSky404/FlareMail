<script lang="ts">
  import type { DeliveryDetail, InboundMessageDetail, MailMessage } from '$lib/mock/mailbox';

  let {
    message = null,
    threadMessages = [],
    deliveryDetail = null,
    deliveryDetailPending = false,
    deliveryDetailError = '',
    inboundDetail = null,
    inboundDetailPending = false,
    inboundDetailError = '',
    pending = false,
    rawDownloadHref = null,
    onToggleStar,
    onToggleRead,
    onEditDraft,
    onForward,
    onReply,
    onReloadDeliveryDetail,
    onRetryDelivery,
    onReloadInboundDetail,
    onSelectThreadMessage,
    onRemove
  }: {
    message?: MailMessage | null;
    threadMessages?: MailMessage[];
    deliveryDetail?: DeliveryDetail | null;
    deliveryDetailPending?: boolean;
    deliveryDetailError?: string;
    inboundDetail?: InboundMessageDetail | null;
    inboundDetailPending?: boolean;
    inboundDetailError?: string;
    pending?: boolean;
    rawDownloadHref?: string | null;
    onToggleStar: (message: MailMessage) => void | Promise<void>;
    onToggleRead: (message: MailMessage) => void | Promise<void>;
    onEditDraft: (message: MailMessage) => void;
    onForward: (message: MailMessage) => void;
    onReply: (message: MailMessage) => void;
    onReloadDeliveryDetail: (message: MailMessage) => void | Promise<void>;
    onRetryDelivery: (message: MailMessage) => void | Promise<void>;
    onReloadInboundDetail: (message: MailMessage) => void | Promise<void>;
    onSelectThreadMessage: (message: MailMessage) => void | Promise<void>;
    onRemove: (message: MailMessage) => void | Promise<void>;
  } = $props();

  const formatDate = (value: string) =>
    new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));

  const visibleBody = $derived(
    message
      ? message.source === 'inbound'
        ? inboundDetail?.body ??
          (inboundDetailPending ? 'Loading body from cloud storage...' : message.body)
        : message.body
      : ''
  );

  const threadCount = $derived(threadMessages.length);
  const attachmentCount = $derived(inboundDetail?.attachments.length ?? 0);
  const deliveryEventCount = $derived(deliveryDetail?.events.length ?? 0);

  const formatBytes = (value: number) => {
    if (value < 1024) {
      return `${value} B`;
    }

    if (value < 1024 * 1024) {
      return `${(value / 1024).toFixed(1)} KB`;
    }

    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  };

  const deliveryLabel = $derived.by(() => {
    if (!message || message.folder !== 'sent') {
      return '';
    }

    if (message.deliveryResultKind === 'accepted' || message.deliveryStatus === 'sent') {
      return 'Delivered';
    }

    if (message.deliveryResultKind === 'queued' || message.deliveryStatus === 'queued') {
      return 'Queued';
    }

    if (message.deliveryResultKind === 'temporary_failure') {
      return 'Temporary Failure';
    }

    if (message.deliveryResultKind === 'rate_limited') {
      return 'Rate Limited';
    }

    return 'Failed';
  });

  const retryLabel = $derived.by(() => {
    if (!message || message.folder !== 'sent') {
      return 'Retry';
    }

    if (message.deliveryResultKind === 'rate_limited') {
      return 'Retry Later';
    }

    if (message.deliveryResultKind === 'temporary_failure' || message.deliveryStatus === 'queued') {
      return 'Process Queue';
    }

    return 'Retry Delivery';
  });
</script>

<div class="flex h-full flex-col">
  {#if message}
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-6 py-3 flex-none">
      <div class="flex flex-wrap items-center gap-2">
        <button class="btn-ghost !py-1 text-xs" onclick={() => onToggleStar(message)} type="button">
          {message.starred ? 'Starred' : 'Star'}
        </button>
        {#if message.folder === 'inbox'}
          <button class="btn-ghost !py-1 text-xs" onclick={() => onToggleRead(message)} type="button">
            {message.read ? 'Mark Unread' : 'Mark Read'}
          </button>
        {:else if message.folder === 'drafts'}
          <button class="btn-ghost !py-1 text-xs" onclick={() => onEditDraft(message)} type="button">
            Continue Editing
          </button>
        {/if}
        <button class="btn-ghost !py-1 text-xs text-red-500 hover:text-red-600" onclick={() => onRemove(message)} type="button">
          {message.folder === 'drafts' ? 'Delete Draft' : 'Delete'}
        </button>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        {#if message.source === 'inbound'}
          <button
            class="btn-ghost !py-1 !px-3 text-xs border border-zinc-200"
            disabled={pending || inboundDetailPending}
            onclick={() => onReloadInboundDetail(message)}
            type="button"
          >
            {inboundDetailPending ? 'Refreshing...' : 'Reload Body'}
          </button>
        {/if}

        {#if message.folder === 'sent'}
          <button
            class="btn-ghost !py-1 !px-3 text-xs border border-zinc-200"
            disabled={pending || deliveryDetailPending}
            onclick={() => onReloadDeliveryDetail(message)}
            type="button"
          >
            {deliveryDetailPending ? 'Refreshing...' : 'Refresh Receipt'}
          </button>

          {#if message.deliveryStatus !== 'sent'}
            <button
              class="btn-ghost !py-1 !px-3 text-xs border border-zinc-200"
              disabled={pending}
              onclick={() => onRetryDelivery(message)}
              type="button"
            >
              {retryLabel}
            </button>
          {/if}
        {/if}

        {#if message.folder === 'inbox'}
          <button class="btn-primary !py-1 !px-3 text-xs" onclick={() => onReply(message)} type="button">Reply</button>
        {/if}
        {#if message.folder !== 'drafts'}
          <button class="btn-ghost !py-1 !px-3 text-xs border border-zinc-200" onclick={() => onForward(message)} type="button">Forward</button>
        {/if}
      </div>
    </div>

    <div class="flex-1 overflow-y-auto px-12 py-10">
      <div class="mx-auto max-w-3xl space-y-10">
        <div class="mb-10">
          <div class="mb-4 flex flex-wrap items-center gap-2">
            <span class="rounded bg-zinc-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-400">
              {message.folder}
            </span>
            <span class="text-[10px] font-mono text-zinc-400">{formatDate(message.sentAt)}</span>
            {#if message.folder === 'sent' && deliveryLabel}
              <span class="rounded bg-zinc-900 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-white">
                {deliveryLabel}
              </span>
            {/if}
          </div>
          <h1 class="text-3xl font-bold tracking-tight text-zinc-950 mb-6">{message.subject}</h1>

          <div class="grid gap-4 border-y border-zinc-100 py-4 md:grid-cols-[minmax(0,1fr)_260px]">
            <div class="flex items-center gap-3 min-w-0">
              <div class="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-xs font-bold uppercase text-white">
                {(message.folder === 'inbox' ? message.fromName : message.toName)?.[0] || '?'}
              </div>
              <div class="min-w-0">
                <p class="mb-1 text-sm font-bold leading-none text-zinc-900">
                  {message.folder === 'inbox' ? message.fromName : message.toName}
                </p>
                <p class="truncate text-xs text-zinc-500">
                  {message.folder === 'inbox' ? message.fromEmail : message.toEmail}
                </p>
                {#if message.cc}
                  <p class="mt-1 truncate text-[11px] text-zinc-400">CC {message.cc}</p>
                {/if}
              </div>
            </div>

            <div class="space-y-1 text-[11px] text-zinc-500">
              <p>
                Labels:
                <span class="text-zinc-800">{message.labels.join(', ') || 'None'}</span>
              </p>
              {#if message.folder === 'sent'}
                <p>
                  Provider:
                  <span class="text-zinc-800">{message.deliveryProvider ?? 'demo'}</span>
                </p>
                <p>
                  Attempts:
                  <span class="text-zinc-800">{message.deliveryAttempts ?? 0}</span>
                </p>
                {#if message.deliveryError}
                  <p>
                    Error:
                    <span class="text-red-600">{message.deliveryError}</span>
                  </p>
                {/if}
              {/if}
              {#if rawDownloadHref}
                <a href={rawDownloadHref} class="inline-flex text-[10px] font-bold uppercase tracking-wider text-zinc-400 hover:text-zinc-900">
                  Download Raw
                </a>
              {/if}
            </div>
          </div>
        </div>

        {#if inboundDetailError}
          <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            {inboundDetailError}
          </div>
        {/if}

        {#if deliveryDetailError}
          <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            {deliveryDetailError}
          </div>
        {/if}

        <div class="whitespace-pre-line text-[15px] leading-relaxed text-zinc-800">
          {visibleBody}
        </div>

        {#if message.source === 'inbound'}
          <section class="space-y-4 rounded-2xl border border-zinc-200 bg-zinc-50 p-5">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p class="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Inbound Archive</p>
                <p class="mt-1 text-sm font-semibold text-zinc-900">
                  {attachmentCount} attachments
                  {#if inboundDetail}
                    / {formatBytes(inboundDetail.rawSize)}
                  {/if}
                </p>
              </div>
              <button
                class="btn-ghost !py-1 !px-3 text-xs border border-zinc-200"
                disabled={pending || inboundDetailPending}
                onclick={() => onReloadInboundDetail(message)}
                type="button"
              >
                {inboundDetailPending ? 'Refreshing...' : 'Reload MIME'}
              </button>
            </div>

            {#if inboundDetail && inboundDetail.attachments.length}
              <div class="space-y-2">
                {#each inboundDetail.attachments as attachment}
                  <div class="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm">
                    <div class="min-w-0">
                      <p class="truncate font-medium text-zinc-900">{attachment.filename}</p>
                      <p class="truncate text-xs text-zinc-500">{attachment.contentType}</p>
                    </div>
                    <span class="shrink-0 text-xs text-zinc-500">
                      {formatBytes(attachment.size)}{attachment.inline ? ' / inline' : ''}
                    </span>
                  </div>
                {/each}
              </div>
            {:else if inboundDetail && !inboundDetailPending}
              <p class="text-sm text-zinc-500">No attachments detected for this message.</p>
            {:else if inboundDetailPending}
              <p class="text-sm text-zinc-500">Loading attachment summary from R2...</p>
            {/if}
          </section>
        {/if}

        {#if message.folder === 'sent'}
          <section class="space-y-4 rounded-2xl border border-zinc-200 bg-zinc-50 p-5">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p class="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Delivery Timeline</p>
                <p class="mt-1 text-sm font-semibold text-zinc-900">
                  {deliveryEventCount} events
                  {#if deliveryDetail?.lastEvent}
                    / {deliveryDetail.lastEvent}
                  {/if}
                </p>
              </div>
              <div class="flex flex-wrap gap-2">
                <button
                  class="btn-ghost !py-1 !px-3 text-xs border border-zinc-200"
                  disabled={pending || deliveryDetailPending}
                  onclick={() => onReloadDeliveryDetail(message)}
                  type="button"
                >
                  {deliveryDetailPending ? 'Refreshing...' : 'Refresh'}
                </button>
                {#if message.deliveryStatus !== 'sent'}
                  <button
                    class="btn-ghost !py-1 !px-3 text-xs border border-zinc-200"
                    disabled={pending}
                    onclick={() => onRetryDelivery(message)}
                    type="button"
                  >
                    {retryLabel}
                  </button>
                {/if}
              </div>
            </div>

            {#if deliveryDetail && deliveryDetail.events.length}
              <div class="space-y-2">
                {#each deliveryDetail.events as event}
                  <div class="rounded-lg border border-zinc-200 bg-white px-4 py-3">
                    <div class="flex flex-wrap items-center justify-between gap-3 text-sm">
                      <span class="font-medium text-zinc-900">{event.type}</span>
                      <span class="text-xs text-zinc-500">{formatDate(event.createdAt)}</span>
                    </div>
                    <p class="mt-2 text-sm leading-6 text-zinc-700">{event.summary}</p>
                  </div>
                {/each}
              </div>
            {:else if deliveryDetailPending}
              <p class="text-sm text-zinc-500">Loading provider receipt timeline...</p>
            {:else}
              <p class="text-sm text-zinc-500">No additional provider events for this message yet.</p>
            {/if}
          </section>
        {/if}

        {#if threadCount > 1}
          <div class="border-t border-zinc-100 pt-8">
            <h4 class="mb-4 text-[10px] font-bold uppercase tracking-widest text-zinc-400">Conversation History</h4>
            <div class="space-y-1">
              {#each threadMessages as tm}
                <button
                  class={`w-full rounded-md p-3 text-left transition-all ${
                    tm.id === message.id ? 'bg-zinc-100' : 'hover:bg-zinc-50'
                  }`}
                  onclick={() => onSelectThreadMessage(tm)}
                  type="button"
                >
                  <div class="flex items-center justify-between gap-3">
                    <div class="min-w-0">
                      <p class="truncate text-xs font-medium text-zinc-700">{tm.preview}</p>
                      <p class="mt-1 text-[10px] uppercase tracking-wider text-zinc-400">
                        {tm.folder === 'inbox' ? 'Inbox' : tm.folder === 'sent' ? 'Sent' : 'Draft'}
                      </p>
                    </div>
                    <span class="shrink-0 text-[10px] font-mono text-zinc-400">{formatDate(tm.sentAt)}</span>
                  </div>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <div class="flex h-full flex-col items-center justify-center opacity-30">
      <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 mb-4 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
      <p class="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">Select a thread to start reading</p>
    </div>
  {/if}
</div>
