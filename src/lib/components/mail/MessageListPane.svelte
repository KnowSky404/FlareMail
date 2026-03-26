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

  const sectionLabels: Record<AppSection, string> = {
    inbox: '收件箱',
    sent: '已发送',
    drafts: '草稿箱',
    profile: '个人资料'
  };

  const formatDate = (value: string) => {
    const date = new Date(value);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) {
      return new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(date);
    }

    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric',
      day: 'numeric'
    }).format(date);
  };
</script>

<div class="flex h-full flex-col bg-zinc-50">
  <div class="h-14 flex items-center justify-between px-4 border-b border-zinc-200 bg-white">
    <h2 class="text-sm font-bold tracking-wide text-zinc-900">{sectionLabels[activeSection]}</h2>
    <span class="text-[10px] font-mono text-zinc-400">
      {activeSection === 'drafts' ? messages.length : threads.length} 封
    </span>
  </div>

  <div class="flex-1 overflow-y-auto">
    {#if activeSection === 'drafts' && messages.length}
      {#each messages as message}
        <button
          class={`w-full border-b border-zinc-100 p-4 text-left transition-colors ${
            selectedMessageId === message.id ? 'bg-white shadow-[inset_3px_0_0_0_#18181b]' : 'hover:bg-zinc-100/50'
          }`}
          type="button"
          onclick={() => onSelect(message)}
        >
          <div class="flex items-center justify-between mb-1">
            <span class="text-[11px] font-bold text-zinc-900 truncate">
              {message.toEmail || '收件人未填写'}
            </span>
            <span class="text-[10px] font-mono text-zinc-400">{formatDate(message.sentAt)}</span>
          </div>
          <h3 class="text-xs font-semibold text-zinc-800 line-clamp-1 mb-1">{message.subject || '（无主题）'}</h3>
          <p class="text-[11px] text-zinc-500 line-clamp-2 leading-relaxed">{message.preview}</p>
        </button>
      {/each}
    {:else if activeSection !== 'drafts' && threads.length}
      {#each threads as thread}
        <button
          class={`w-full border-b border-zinc-100 p-4 text-left transition-colors ${
            selectedThreadId === thread.id ? 'bg-white shadow-[inset_3px_0_0_0_#18181b]' : 'hover:bg-zinc-100/50'
          }`}
          type="button"
          onclick={() => onSelectThread(thread)}
        >
          <div class="flex items-center justify-between mb-1">
            <span class={`text-[11px] font-bold truncate ${thread.unreadCount > 0 ? 'text-blue-600' : 'text-zinc-900'}`}>
              {thread.counterpartLabel}
            </span>
            <span class="text-[10px] font-mono text-zinc-400">{formatDate(thread.sentAt)}</span>
          </div>
          <h3 class={`text-xs font-semibold line-clamp-1 mb-1 ${thread.unreadCount > 0 ? 'text-zinc-950' : 'text-zinc-700'}`}>
            {thread.subject}
          </h3>
          <p class="text-[11px] text-zinc-500 line-clamp-2 leading-relaxed">{thread.preview}</p>
          
          {#if thread.unreadCount > 0}
            <div class="mt-2 flex">
              <span class="rounded-sm bg-blue-600 px-1.5 py-0.5 text-[9px] font-bold text-white">未读</span>
            </div>
          {/if}
        </button>
      {/each}
    {:else}
      <div class="flex h-full flex-col items-center justify-center px-8 text-center">
        <p class="text-sm font-semibold text-zinc-800">{sectionLabels[activeSection]}暂时为空</p>
        <p class="mt-2 max-w-xs text-xs leading-6 text-zinc-500">
          {activeSection === 'drafts'
            ? '你保存的草稿会出现在这里，刷新后也会保留。'
            : activeSection === 'inbox'
              ? '新的入站邮件写入后会显示在这里。'
              : '写出的邮件记录会在这里聚合展示。'}
        </p>
      </div>
    {/if}
  </div>
</div>
