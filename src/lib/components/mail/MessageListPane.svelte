<script lang="ts">
  import type { MailFolder, MailMessage, MailThread } from '$lib/mock/mailbox';

  type AppSection = MailFolder | 'profile';

  let {
    activeSection,
    messages,
    threads = [],
    selectedMessageId,
    selectedThreadId = null,
    onSelect,
    onSelectThread
  }: {
    activeSection: AppSection;
    messages: MailMessage[];
    threads?: MailThread[];
    selectedMessageId: string | null;
    selectedThreadId?: string | null;
    onSelect: (message: MailMessage) => void | Promise<void>;
    onSelectThread: (thread: MailThread) => void | Promise<void>;
  } = $props();

  const formatDate = (value: string) =>
    new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));

  const folderMeta = $derived(
    activeSection === 'inbox'
      ? { eyebrow: 'Inbox', title: '对话列表' }
      : activeSection === 'sent'
        ? { eyebrow: 'Sent', title: '往来线程' }
        : { eyebrow: 'Drafts', title: '草稿列表' }
  );

  const getCounterparty = (message: MailMessage) =>
    message.folder === 'inbox'
      ? message.fromName
      : message.folder === 'sent'
        ? message.toEmail
        : message.toEmail || '待填写收件人';

  const getDeliveryLabel = (message: MailMessage) =>
    message.deliveryResultKind === 'accepted'
      ? '已提交'
      : message.deliveryResultKind === 'temporary_failure'
        ? '待重试'
        : message.deliveryResultKind === 'rate_limited'
          ? '限流中'
          : message.deliveryResultKind === 'permanent_failure'
            ? '失败'
            : message.deliveryStatus === 'queued'
              ? '排队中'
              : message.deliveryStatus === 'failed'
                ? '失败'
                : message.deliveryStatus === 'sent'
                  ? '已送达'
                  : '';

  const getDeliveryTone = (message: MailMessage) =>
    message.deliveryResultKind === 'permanent_failure' || message.deliveryStatus === 'failed'
      ? 'text-coral'
      : message.deliveryResultKind === 'temporary_failure' ||
          message.deliveryResultKind === 'rate_limited' ||
          message.deliveryStatus === 'queued'
        ? 'text-accent'
        : 'text-mist';

  const getThreadStateLabel = (thread: MailThread) => {
    if (thread.unreadCount > 0) {
      return `${thread.unreadCount} 封未读`;
    }

    if (thread.latestMessage.folder === 'sent' && thread.latestMessage.deliveryStatus) {
      return getDeliveryLabel(thread.latestMessage);
    }

    return thread.latestMessage.folder === 'sent' ? '最近由你发出' : '最近收到';
  };
</script>

<section class="rounded-[2rem] border border-night/10 bg-shell/94 p-4 shadow-[0_20px_70px_rgba(32,27,22,0.04)]">
  <div class="flex items-center justify-between border-b border-night/8 px-2 pb-4">
    <div>
      <p class="text-[11px] uppercase tracking-[0.28em] text-mist">{folderMeta.eyebrow}</p>
      <h2 class="mt-1 text-2xl text-ink">{folderMeta.title}</h2>
    </div>
    <p class="text-sm text-mist">
      {activeSection === 'drafts' ? `${messages.length} 封邮件` : `${threads.length} 段对话`}
    </p>
  </div>

  <div class="mt-4 space-y-3">
    {#if activeSection === 'drafts'}
      {#each messages as message}
        <button
          class={`block w-full rounded-[1.5rem] border px-4 py-4 text-left transition ${
            selectedMessageId === message.id
              ? 'border-ink bg-ink text-paper'
              : 'border-night/10 bg-paper text-ink hover:border-night/20'
          }`}
          onclick={() => onSelect(message)}
          type="button"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2 text-sm">
                <span class="font-medium">{getCounterparty(message)}</span>
                {#if message.starred}
                  <span class={`text-[11px] ${selectedMessageId === message.id ? 'text-paper/70' : 'text-accent'}`}>
                    星标
                  </span>
                {/if}
                <span class={`text-[11px] ${selectedMessageId === message.id ? 'text-paper/70' : 'text-mist'}`}>
                  草稿
                </span>
              </div>
              <p class="mt-2 line-clamp-1 text-base font-medium">{message.subject}</p>
              <p
                class={`mt-2 line-clamp-2 text-sm leading-6 ${
                  selectedMessageId === message.id ? 'text-paper/72' : 'text-mist'
                }`}
              >
                {message.preview}
              </p>
            </div>
            <span class={`shrink-0 text-xs ${selectedMessageId === message.id ? 'text-paper/65' : 'text-mist'}`}>
              {formatDate(message.sentAt)}
            </span>
          </div>
        </button>
      {/each}
    {:else}
      {#each threads as thread}
        <button
          class={`block w-full rounded-[1.5rem] border px-4 py-4 text-left transition ${
            selectedThreadId === thread.id
              ? 'border-ink bg-ink text-paper'
              : 'border-night/10 bg-paper text-ink hover:border-night/20'
          }`}
          onclick={() => onSelectThread(thread)}
          type="button"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2 text-sm">
                <span class={`font-medium ${thread.unreadCount > 0 ? 'text-coral' : ''}`}>
                  {thread.counterpartLabel}
                </span>
                <span class={`text-[11px] ${selectedThreadId === thread.id ? 'text-paper/70' : 'text-mist'}`}>
                  {thread.messageCount} 封
                </span>
                <span
                  class={`text-[11px] ${
                    selectedThreadId === thread.id
                      ? 'text-paper/70'
                      : thread.unreadCount > 0
                        ? 'text-coral'
                        : getDeliveryTone(thread.latestMessage)
                  }`}
                >
                  {getThreadStateLabel(thread)}
                </span>
              </div>
              <p class="mt-2 line-clamp-1 text-base font-medium">{thread.subject}</p>
              <p
                class={`mt-2 line-clamp-2 text-sm leading-6 ${
                  selectedThreadId === thread.id ? 'text-paper/72' : 'text-mist'
                }`}
              >
                {thread.preview}
              </p>
              <p
                class={`mt-3 text-xs ${
                  selectedThreadId === thread.id ? 'text-paper/65' : 'text-mist'
                }`}
              >
                当前分栏内 {thread.sectionMessageCount} 封，整段对话 {thread.messageCount} 封。
              </p>
            </div>
            <span class={`shrink-0 text-xs ${selectedThreadId === thread.id ? 'text-paper/65' : 'text-mist'}`}>
              {formatDate(thread.sentAt)}
            </span>
          </div>
        </button>
      {/each}
    {/if}
  </div>
</section>
