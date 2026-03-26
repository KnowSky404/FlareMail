<script lang="ts">
  import {
    type ComposeInput,
    type ComposeMode,
    type UserProfile
  } from '$lib/mock/mailbox';
  import { onMount } from 'svelte';

  const createComposeState = (value: ComposeInput | null): ComposeInput =>
    value
      ? {
          draftId: value.draftId,
          toEmail: value.toEmail,
          cc: value.cc ?? '',
          subject: value.subject,
          body: value.body
        }
      : {
          toEmail: '',
          cc: '',
          subject: '',
          body: ''
        };

  let {
    initialInput = null,
    draftId = undefined,
    mode = 'new',
    profile,
    pending = false,
    autosaveStatus = 'idle',
    autosaveMessage = '自动保存会在停顿后触发。',
    onClose,
    onInputChange,
    onSaveDraft,
    onSend
  }: {
    initialInput?: ComposeInput | null;
    draftId?: string | undefined;
    mode?: ComposeMode;
    profile: UserProfile;
    pending?: boolean;
    autosaveStatus?: 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
    autosaveMessage?: string;
    onClose: () => void;
    onInputChange?: (input: ComposeInput) => void;
    onSaveDraft: (input: ComposeInput) => void | Promise<void>;
    onSend: (input: ComposeInput) => void | Promise<void>;
  } = $props();

  let input = $state<ComposeInput>(createComposeState(null));

  $effect(() => {
    input = createComposeState(initialInput);
  });

  $effect(() => {
    if (draftId && draftId !== input.draftId) {
      input = {
        ...input,
        draftId
      };
    }
  });

  onMount(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  const title = $derived(
    mode === 'new' ? '新邮件' : mode === 'reply' ? '回复邮件' : mode === 'forward' ? '转发邮件' : '编辑草稿'
  );

  const autosaveTone = $derived(
    autosaveStatus === 'error'
      ? 'text-coral'
      : autosaveStatus === 'saved'
        ? 'text-accent'
        : autosaveStatus === 'saving'
          ? 'text-gold'
          : 'text-mist'
  );

  function updateInput<K extends keyof ComposeInput>(key: K, value: ComposeInput[K]) {
    const next = {
      ...input,
      [key]: value
    };

    input = next;
    onInputChange?.(next);
  }
</script>

<!-- Backdrop -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 backdrop-blur-sm p-4">
  <!-- Modal Content -->
  <div class="paper-card flex h-full max-h-[850px] w-full max-w-4xl flex-col overflow-hidden rounded-2xl shadow-2xl">
    <!-- Header -->
    <header class="flex items-center justify-between border-b border-line bg-shell/50 px-6 py-4">
      <div class="flex items-center gap-3">
        <span class="meta-text text-gold">{title}</span>
        <span class="h-1 w-1 rounded-full bg-line"></span>
        <span class="meta-text">{profile.email}</span>
      </div>
      <button
        aria-label="关闭写信弹窗"
        class="text-mist transition-colors hover:text-coral"
        onclick={onClose}
        type="button"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </header>

    <!-- Form -->
    <div class="flex-1 overflow-y-auto bg-shell/30 p-8 lg:p-12">
      <div class="mx-auto max-w-3xl space-y-8">
        <div class="space-y-4">
          <div class="group relative border-b border-line pb-2 focus-within:border-gold transition-colors">
            <span class="absolute -top-4 left-0 text-[10px] font-bold uppercase tracking-widest text-mist">收件人</span>
            <input
              class="w-full bg-transparent text-sm font-semibold text-ink outline-none"
              placeholder="someone@example.com"
              type="email"
              value={input.toEmail}
              oninput={(event) => updateInput('toEmail', event.currentTarget.value)}
            />
          </div>

          <div class="group relative border-b border-line pb-2 focus-within:border-gold transition-colors">
            <span class="absolute -top-4 left-0 text-[10px] font-bold uppercase tracking-widest text-mist">抄送</span>
            <input
              class="w-full bg-transparent text-sm text-ink outline-none"
              placeholder="optional@example.com"
              type="text"
              value={input.cc ?? ''}
              oninput={(event) => updateInput('cc', event.currentTarget.value)}
            />
          </div>

          <div class="group relative border-b border-line pb-2 focus-within:border-gold transition-colors">
            <span class="absolute -top-4 left-0 text-[10px] font-bold uppercase tracking-widest text-mist">主题</span>
            <input
              class="editorial-heading w-full bg-transparent text-2xl text-ink outline-none"
              placeholder="输入邮件主题"
              type="text"
              value={input.subject}
              oninput={(event) => updateInput('subject', event.currentTarget.value)}
            />
          </div>
        </div>

        <div class="relative mt-12">
          <textarea
            class="min-h-[400px] w-full resize-none bg-transparent text-[16px] leading-[1.8] text-ink/90 outline-none placeholder:text-mist/30"
            placeholder="在这里撰写正文..."
            value={input.body}
            oninput={(event) => updateInput('body', event.currentTarget.value)}
          ></textarea>
        </div>
      </div>
    </div>

    <!-- Footer Actions -->
    <footer class="flex items-center justify-between border-t border-line bg-shell/50 px-8 py-6">
      <div class="flex items-center gap-6">
        <button
          class="meta-text transition-colors hover:text-gold disabled:opacity-50"
          disabled={pending}
          onclick={() => onSaveDraft(input)}
          type="button"
        >
          保存草稿
        </button>
        <span class="h-4 w-px bg-line"></span>
        <p class={`text-[10px] italic ${autosaveTone}`}>
          {autosaveMessage}
        </p>
      </div>

      <div class="flex items-center gap-4">
        <button
          class="border border-line px-8 py-3 text-[10px] font-bold uppercase tracking-widest text-ink transition-all hover:bg-paper"
          onclick={onClose}
          type="button"
        >
          取消
        </button>
        <button
          class="bg-ink px-10 py-3 text-[10px] font-bold uppercase tracking-widest text-paper transition-all hover:bg-accent disabled:opacity-50"
          disabled={pending}
          onclick={() => onSend(input)}
          type="button"
        >
          {pending ? '正在发送...' : '发送邮件'}
        </button>
      </div>
    </footer>
  </div>
</div>
