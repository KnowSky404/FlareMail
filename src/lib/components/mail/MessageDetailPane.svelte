<script lang="ts">
  import type { DeliveryDetail, InboundMessageDetail, MailMessage } from '$lib/mock/mailbox';

  let {
    message = null,
    threadMessages = [],
    deliveryDetail = null,
    deliveryDetailPending = false,
    inboundDetail = null,
    inboundDetailPending = false,
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
</script>

<div class="flex h-full flex-col">
  {#if message}
    <div class="h-14 flex items-center justify-between px-6 border-b border-zinc-200 flex-none">
      <div class="flex items-center gap-2">
        <button class="btn-ghost !py-1 text-xs" onclick={() => onToggleStar(message)}>
           {message.starred ? 'Starred' : 'Star'}
        </button>
        <button class="btn-ghost !py-1 text-xs" onclick={() => onRemove(message)}>Archive</button>
      </div>

      <div class="flex items-center gap-2">
        {#if message.folder === 'inbox'}
          <button class="btn-primary !py-1 !px-3 text-xs" onclick={() => onReply(message)}>Reply</button>
        {/if}
        <button class="btn-ghost !py-1 !px-3 text-xs border border-zinc-200" onclick={() => onForward(message)}>Forward</button>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto px-12 py-10">
      <div class="mx-auto max-w-3xl">
        <div class="mb-10">
          <div class="flex items-center gap-2 mb-4">
             <span class="text-[10px] font-bold uppercase tracking-widest text-zinc-400 bg-zinc-100 px-2 py-0.5 rounded">
                {message.folder}
             </span>
             <span class="text-[10px] font-mono text-zinc-400">{formatDate(message.sentAt)}</span>
          </div>
          <h1 class="text-3xl font-bold tracking-tight text-zinc-950 mb-6">{message.subject}</h1>
          
          <div class="flex items-center justify-between py-4 border-y border-zinc-100">
            <div class="flex items-center gap-3">
               <div class="h-8 w-8 rounded-full bg-zinc-900 text-white flex items-center justify-center text-xs font-bold uppercase">
                  {(message.folder === 'inbox' ? message.fromName : message.toName)?.[0] || '?'}
               </div>
               <div class="min-w-0">
                  <p class="text-sm font-bold text-zinc-900 leading-none mb-1">
                    {message.folder === 'inbox' ? message.fromName : message.toName}
                  </p>
                  <p class="text-xs text-zinc-500 truncate">
                    {message.folder === 'inbox' ? message.fromEmail : message.toEmail}
                  </p>
               </div>
            </div>
            
            {#if rawDownloadHref}
              <a href={rawDownloadHref} class="text-[10px] font-bold uppercase tracking-wider text-zinc-400 hover:text-zinc-900">Download Raw</a>
            {/if}
          </div>
        </div>

        <div class="text-[15px] leading-relaxed text-zinc-800 whitespace-pre-line mb-16">
          {visibleBody}
        </div>

        {#if threadCount > 1}
           <div class="mt-16 pt-8 border-t border-zinc-100">
              <h4 class="text-[10px] font-bold uppercase tracking-widest text-zinc-400 mb-4">Conversation History</h4>
              <div class="space-y-1">
                {#each threadMessages as tm}
                   <button 
                    class={`w-full flex items-center justify-between p-3 rounded-md text-left transition-all ${tm.id === message.id ? 'bg-zinc-100' : 'hover:bg-zinc-50'}`}
                    onclick={() => onSelectThreadMessage(tm)}
                   >
                     <span class="text-xs font-medium text-zinc-700 truncate mr-4">{tm.preview}</span>
                     <span class="text-[10px] font-mono text-zinc-400 shrink-0">{formatDate(tm.sentAt)}</span>
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
