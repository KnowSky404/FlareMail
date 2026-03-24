<script lang="ts">
  import type { MailFolder, MailMessage } from '$lib/mock/mailbox';

  type AppSection = MailFolder | 'profile';

  let {
    activeSection,
    messages,
    selectedMessageId,
    onSelect
  }: {
    activeSection: AppSection;
    messages: MailMessage[];
    selectedMessageId: string | null;
    onSelect: (message: MailMessage) => void | Promise<void>;
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
      ? { eyebrow: 'Inbox', title: '邮件列表' }
      : activeSection === 'sent'
        ? { eyebrow: 'Sent', title: '发送记录' }
        : { eyebrow: 'Drafts', title: '草稿列表' }
  );

  const getCounterparty = (message: MailMessage) =>
    message.folder === 'inbox'
      ? message.fromName
      : message.folder === 'sent'
        ? message.toEmail
        : message.toEmail || '待填写收件人';
</script>

<section class="rounded-[2rem] border border-night/10 bg-shell/94 p-4 shadow-[0_20px_70px_rgba(32,27,22,0.04)]">
  <div class="flex items-center justify-between border-b border-night/8 px-2 pb-4">
    <div>
      <p class="text-[11px] uppercase tracking-[0.28em] text-mist">{folderMeta.eyebrow}</p>
      <h2 class="mt-1 text-2xl text-ink">{folderMeta.title}</h2>
    </div>
    <p class="text-sm text-mist">{messages.length} 封邮件</p>
  </div>

  <div class="mt-4 space-y-3">
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
              <span class={`font-medium ${!message.read && message.folder === 'inbox' ? 'text-coral' : ''}`}>
                {getCounterparty(message)}
              </span>
              {#if message.starred}
                <span class={`text-[11px] ${selectedMessageId === message.id ? 'text-paper/70' : 'text-accent'}`}>
                  星标
                </span>
              {/if}
              {#if message.folder === 'drafts'}
                <span class={`text-[11px] ${selectedMessageId === message.id ? 'text-paper/70' : 'text-mist'}`}>
                  草稿
                </span>
              {/if}
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
  </div>
</section>
