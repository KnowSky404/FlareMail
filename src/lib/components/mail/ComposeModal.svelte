<script lang="ts">
  import {
    type ComposeInput,
    type ComposeMode,
    type UserProfile
  } from '$lib/mock/mailbox';
  import { onMount } from 'svelte';

  let {
    initialInput = null,
    mode = 'new',
    profile,
    pending = false,
    onClose,
    onSaveDraft,
    onSend
  }: {
    initialInput?: ComposeInput | null;
    mode?: ComposeMode;
    profile: UserProfile;
    pending?: boolean;
    onClose: () => void;
    onSaveDraft: (input: ComposeInput) => void | Promise<void>;
    onSend: (input: ComposeInput) => void | Promise<void>;
  } = $props();

  let input = $state<ComposeInput>(initialInput ?? {
    toEmail: '',
    cc: '',
    subject: '',
    body: ''
  });

  onMount(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  const title = $derived(
    mode === 'new' ? 'New Correspondence' : mode === 'reply' ? 'Reply' : mode === 'forward' ? 'Forward' : 'Draft'
  );
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
      <button class="text-mist transition-colors hover:text-coral" onclick={onClose}>
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
            <span class="absolute -top-4 left-0 text-[10px] font-bold uppercase tracking-widest text-mist">Recipient</span>
            <input
              bind:value={input.toEmail}
              class="w-full bg-transparent text-sm font-semibold text-ink outline-none"
              placeholder="recipient@example.com"
              type="email"
            />
          </div>

          <div class="group relative border-b border-line pb-2 focus-within:border-gold transition-colors">
            <span class="absolute -top-4 left-0 text-[10px] font-bold uppercase tracking-widest text-mist">Cc</span>
            <input
              bind:value={input.cc}
              class="w-full bg-transparent text-sm text-ink outline-none"
              placeholder="optional@example.com"
              type="text"
            />
          </div>

          <div class="group relative border-b border-line pb-2 focus-within:border-gold transition-colors">
            <span class="absolute -top-4 left-0 text-[10px] font-bold uppercase tracking-widest text-mist">Subject</span>
            <input
              bind:value={input.subject}
              class="editorial-heading w-full bg-transparent text-2xl text-ink outline-none"
              placeholder="Title of your message"
              type="text"
            />
          </div>
        </div>

        <div class="relative mt-12">
          <textarea
            bind:value={input.body}
            class="min-h-[400px] w-full resize-none bg-transparent text-[16px] leading-[1.8] text-ink/90 outline-none placeholder:text-mist/30"
            placeholder="Compose your message here..."
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
          Save as Draft
        </button>
        <span class="h-4 w-px bg-line"></span>
        <p class="text-[10px] text-mist italic">
          Auto-saving is currently disabled.
        </p>
      </div>

      <div class="flex items-center gap-4">
        <button
          class="border border-line px-8 py-3 text-[10px] font-bold uppercase tracking-widest text-ink transition-all hover:bg-paper"
          onclick={onClose}
          type="button"
        >
          Cancel
        </button>
        <button
          class="bg-ink px-10 py-3 text-[10px] font-bold uppercase tracking-widest text-paper transition-all hover:bg-accent disabled:opacity-50"
          disabled={pending}
          onclick={() => onSend(input)}
          type="button"
        >
          {pending ? 'Dispatching...' : 'Send Message'}
        </button>
      </div>
    </footer>
  </div>
</div>
