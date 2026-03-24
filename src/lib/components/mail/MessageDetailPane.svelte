<script lang="ts">
  import type { MailMessage } from '$lib/mock/mailbox';

  let {
    message = null,
    pending = false,
    onToggleStar,
    onToggleRead,
    onEditDraft,
    onRemove
  }: {
    message?: MailMessage | null;
    pending?: boolean;
    onToggleStar: (message: MailMessage) => void | Promise<void>;
    onToggleRead: (message: MailMessage) => void | Promise<void>;
    onEditDraft: (message: MailMessage) => void;
    onRemove: (message: MailMessage) => void | Promise<void>;
  } = $props();

  const formatDate = (value: string) =>
    new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));
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
          </div>
        </div>

        <div class="flex flex-wrap gap-2">
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

      <div class="flex-1 whitespace-pre-line py-6 text-[15px] leading-8 text-ink">
        {message.body}
      </div>

      <div class="border-t border-night/8 pt-4 text-sm text-mist">
        <p>
          {message.folder === 'inbox'
            ? '这里可以继续扩展回复、转发、归档、多选批量处理等真实邮件能力。'
            : message.folder === 'sent'
              ? '这里可以继续扩展撤回、再次编辑、模板发送与草稿箱。'
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
