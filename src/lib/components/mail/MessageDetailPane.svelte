<script lang="ts">
  import type { InboundMessageDetail, MailMessage } from '$lib/mock/mailbox';

  let {
    message = null,
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
    onRetryDelivery,
    onReloadInboundDetail,
    onRemove
  }: {
    message?: MailMessage | null;
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
    onRetryDelivery: (message: MailMessage) => void | Promise<void>;
    onReloadInboundDetail: (message: MailMessage) => void | Promise<void>;
    onRemove: (message: MailMessage) => void | Promise<void>;
  } = $props();

  const formatDate = (value: string) =>
    new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));

  const formatBytes = (value: number) => {
    if (value < 1024) {
      return `${value} B`;
    }

    if (value < 1024 * 1024) {
      return `${(value / 1024).toFixed(1)} KB`;
    }

    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  };

  const visibleBody = $derived(
    message
      ? message.source === 'inbound'
        ? inboundDetail?.body ??
          (inboundDetailPending ? '正在从 R2 读取原始邮件并解析正文…' : message.body)
        : message.body
      : ''
  );

  const attachmentCount = $derived(inboundDetail?.attachments.length ?? 0);
  const deliveryLabel = $derived(
    message?.deliveryStatus === 'queued'
      ? '排队中'
      : message?.deliveryStatus === 'failed'
        ? '投递失败'
        : message?.deliveryStatus === 'sent'
          ? '已送达'
          : ''
  );
</script>

<section class="rounded-[2rem] border border-night/10 bg-shell/94 p-4 shadow-[0_20px_70px_rgba(32,27,22,0.04)]">
  {#if message}
    <article class="flex h-full flex-col rounded-[1.5rem] border border-night/10 bg-paper p-5 md:p-6">
      <div class="flex flex-wrap items-start justify-between gap-4 border-b border-night/8 pb-5">
        <div class="space-y-3">
          <p class="text-[11px] uppercase tracking-[0.28em] text-mist">
            {message.folder === 'inbox'
              ? '收到的邮件'
              : message.folder === 'sent'
                ? '发送的邮件'
                : '未发送草稿'}
          </p>
          <h2 class="max-w-3xl font-display text-3xl leading-tight text-ink">
            {message.subject}
          </h2>
          <div class="text-sm leading-6 text-mist">
            <p>
              {message.folder === 'inbox' ? '发件人' : '收件人'}：
              <span class="text-ink">
                {message.folder === 'inbox'
                  ? `${message.fromName} <${message.fromEmail}>`
                  : `${message.toName} <${message.toEmail}>`}
              </span>
            </p>
            {#if message.cc}
              <p>抄送：<span class="text-ink">{message.cc}</span></p>
            {/if}
            <p>时间：<span class="text-ink">{formatDate(message.sentAt)}</span></p>
            <p>标签：<span class="text-ink">{message.labels.join(' / ')}</span></p>
            {#if message.folder === 'sent' && message.deliveryStatus}
              <p>投递状态：<span class="text-ink">{deliveryLabel}</span></p>
              <p>尝试次数：<span class="text-ink">{message.deliveryAttempts ?? 0}</span></p>
              {#if message.deliveredAt}
                <p>投递时间：<span class="text-ink">{formatDate(message.deliveredAt)}</span></p>
              {/if}
              {#if message.deliveryError}
                <p>失败原因：<span class="text-ink">{message.deliveryError}</span></p>
              {/if}
            {/if}
          </div>
        </div>

        <div class="flex flex-wrap gap-2">
          {#if message.folder === 'inbox'}
            <button
              class="rounded-full border border-night/10 px-3 py-2 text-sm text-ink transition hover:border-accent hover:text-accent disabled:opacity-60"
              disabled={pending}
              onclick={() => onReply(message)}
              type="button"
            >
              回复
            </button>
          {/if}

          {#if message.folder !== 'drafts'}
            <button
              class="rounded-full border border-night/10 px-3 py-2 text-sm text-ink transition hover:border-accent hover:text-accent disabled:opacity-60"
              disabled={pending}
              onclick={() => onForward(message)}
              type="button"
            >
              转发
            </button>
          {/if}

          {#if message.folder === 'sent' && message.deliveryStatus !== 'sent'}
            <button
              class="rounded-full border border-night/10 px-3 py-2 text-sm text-ink transition hover:border-accent hover:text-accent disabled:opacity-60"
              disabled={pending}
              onclick={() => onRetryDelivery(message)}
              type="button"
            >
              {message.deliveryStatus === 'queued' ? '继续处理队列' : '重试投递'}
            </button>
          {/if}

          {#if message.source === 'inbound'}
            <button
              class="rounded-full border border-night/10 px-3 py-2 text-sm text-ink transition hover:border-accent hover:text-accent disabled:opacity-60"
              disabled={pending || inboundDetailPending}
              onclick={() => onReloadInboundDetail(message)}
              type="button"
            >
              {inboundDetailPending ? '载入中…' : '重新载入正文'}
            </button>

            {#if rawDownloadHref}
              <a
                class="rounded-full border border-night/10 px-3 py-2 text-sm text-ink transition hover:border-accent hover:text-accent"
                href={rawDownloadHref}
              >
                下载 .eml
              </a>
            {/if}
          {/if}

          <button
            class="rounded-full border border-night/10 px-3 py-2 text-sm text-ink transition hover:border-accent hover:text-accent disabled:opacity-60"
            disabled={pending}
            onclick={() => onToggleStar(message)}
            type="button"
          >
            {message.starred ? '取消星标' : '标记星标'}
          </button>

          {#if message.folder === 'inbox'}
            <button
              class="rounded-full border border-night/10 px-3 py-2 text-sm text-ink transition hover:border-accent hover:text-accent disabled:opacity-60"
              disabled={pending}
              onclick={() => onToggleRead(message)}
              type="button"
            >
              {message.read ? '标记未读' : '标记已读'}
            </button>
          {:else if message.folder === 'drafts'}
            <button
              class="rounded-full border border-night/10 px-3 py-2 text-sm text-ink transition hover:border-accent hover:text-accent disabled:opacity-60"
              disabled={pending}
              onclick={() => onEditDraft(message)}
              type="button"
            >
              继续编辑
            </button>
          {/if}

          <button
            class="rounded-full border border-night/10 px-3 py-2 text-sm text-ink transition hover:border-coral hover:text-coral disabled:opacity-60"
            disabled={pending}
            onclick={() => onRemove(message)}
            type="button"
          >
            {message.folder === 'drafts' ? '删除草稿' : '删除'}
          </button>
        </div>
      </div>

      <div class="flex-1 py-6">
        {#if inboundDetailError}
          <div class="rounded-[1.25rem] border border-coral/20 bg-coral/8 px-4 py-3 text-sm leading-6 text-coral">
            {inboundDetailError}
          </div>
        {/if}

        <div class="whitespace-pre-line pt-0 text-[15px] leading-8 text-ink">
          {visibleBody}
        </div>

        {#if message.source === 'inbound'}
          <div class="mt-6 rounded-[1.5rem] border border-night/10 bg-shell/70 p-4">
            <div class="flex flex-wrap items-center justify-between gap-3 text-sm text-mist">
              <span>原始邮件存档</span>
              <span>
                {attachmentCount} 个附件
                {#if inboundDetail}
                  / {formatBytes(inboundDetail.rawSize)}
                {/if}
              </span>
            </div>

            {#if inboundDetail && inboundDetail.attachments.length}
              <div class="mt-4 space-y-2">
                {#each inboundDetail.attachments as attachment}
                  <div class="flex items-center justify-between gap-3 rounded-[1rem] border border-night/8 bg-paper px-4 py-3 text-sm">
                    <div class="min-w-0">
                      <p class="truncate font-medium text-ink">{attachment.filename}</p>
                      <p class="truncate text-mist">{attachment.contentType}</p>
                    </div>
                    <span class="shrink-0 text-mist">
                      {formatBytes(attachment.size)}{attachment.inline ? ' / inline' : ''}
                    </span>
                  </div>
                {/each}
              </div>
            {:else if inboundDetail && !inboundDetailPending}
              <p class="mt-4 text-sm leading-6 text-mist">这封邮件没有检测到附件。</p>
            {/if}
          </div>
        {/if}
      </div>

      <div class="border-t border-night/8 pt-4 text-sm text-mist">
        <p>
          {message.folder === 'inbox'
            ? '收件箱现在已经支持回复与转发，下一步可以继续接归档、批量处理和线程视图。'
            : message.folder === 'sent'
              ? '已发送现在支持排队、失败和重试。后续可以把这里接到真实 provider、Webhooks 和投递回执。'
              : '草稿现在已经支持继续编辑、保存和发送，下一步可以接自动保存与收件人补全。'}
        </p>
      </div>
    </article>
  {:else}
    <div class="flex h-full items-center justify-center rounded-[1.5rem] border border-dashed border-night/14 bg-paper p-8 text-center text-sm leading-7 text-mist">
      当前列表为空，可以点击“模拟收信”或“写邮件”继续演示。
    </div>
  {/if}
</section>
