<script lang="ts">
  import type { ComposeInput, ComposeMode, UserProfile } from '$lib/mock/mailbox';

  const defaultDraft = {
    toEmail: '',
    cc: '',
    subject: '',
    body: ''
  };

  let {
    profile,
    mode = 'new',
    initialInput = null,
    pending = false,
    onClose,
    onSaveDraft,
    onSend
  }: {
    profile: UserProfile;
    mode?: ComposeMode;
    initialInput?: ComposeInput | null;
    pending?: boolean;
    onClose: () => void;
    onSaveDraft: (input: ComposeInput) => void | Promise<void>;
    onSend: (input: ComposeInput) => void | Promise<void>;
  } = $props();

  let form = $state<ComposeInput>(defaultDraft);

  const title = $derived(
    mode === 'reply'
      ? '回复邮件'
      : mode === 'forward'
        ? '转发邮件'
        : mode === 'draft'
          ? '编辑草稿'
          : '新建邮件'
  );
  const saveLabel = $derived(mode === 'draft' ? '更新草稿' : '保存草稿');
  const sendLabel = $derived(
    mode === 'reply'
      ? '发送回复'
      : mode === 'forward'
        ? '发送转发'
        : mode === 'draft'
          ? '发送草稿'
          : '发送邮件'
  );

  $effect(() => {
    form = initialInput
      ? {
          draftId: initialInput.draftId,
          toEmail: initialInput.toEmail,
          cc: initialInput.cc ?? '',
          subject: initialInput.subject,
          body: initialInput.body
        }
      : {
          ...defaultDraft
        };
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    await onSend(form);
  }

  async function saveDraft() {
    await onSaveDraft(form);
  }
</script>

<div class="fixed inset-0 z-40 flex items-end justify-center bg-ink/16 p-3 backdrop-blur-sm md:items-center">
  <div class="w-full max-w-2xl rounded-[2rem] border border-night/10 bg-shell p-5 shadow-[0_30px_100px_rgba(32,27,22,0.12)] md:p-6">
    <div class="flex items-center justify-between gap-4">
      <div>
        <p class="text-[11px] uppercase tracking-[0.28em] text-mist">写邮件</p>
        <h2 class="mt-2 font-display text-3xl text-ink">{title}</h2>
      </div>
      <button
        class="rounded-full border border-night/10 px-3 py-2 text-sm text-mist transition hover:text-ink"
        onclick={onClose}
        type="button"
      >
        关闭
      </button>
    </div>

    <form class="mt-6 space-y-4" onsubmit={submit}>
      <label class="block space-y-2">
        <span class="text-sm text-mist">收件人</span>
        <input bind:value={form.toEmail} class="w-full rounded-2xl border border-night/10 bg-paper px-4 py-3 text-ink outline-none transition focus:border-accent" type="email" />
      </label>

      <label class="block space-y-2">
        <span class="text-sm text-mist">抄送</span>
        <input bind:value={form.cc} class="w-full rounded-2xl border border-night/10 bg-paper px-4 py-3 text-ink outline-none transition focus:border-accent" type="text" />
      </label>

      <label class="block space-y-2">
        <span class="text-sm text-mist">主题</span>
        <input bind:value={form.subject} class="w-full rounded-2xl border border-night/10 bg-paper px-4 py-3 text-ink outline-none transition focus:border-accent" type="text" />
      </label>

      <label class="block space-y-2">
        <span class="text-sm text-mist">正文</span>
        <textarea
          bind:value={form.body}
          class="min-h-56 w-full rounded-[1.5rem] border border-night/10 bg-paper px-4 py-3 text-sm leading-7 text-ink outline-none transition focus:border-accent"
        ></textarea>
      </label>

      <div class="flex flex-wrap items-center justify-between gap-3 pt-2">
        <div class="space-y-1 text-sm text-mist">
          <p>
            将使用 <span class="text-ink">{profile.email}</span> 与当前签名发送。
          </p>
          <p class="text-xs">
            演示提示：收件人包含 `+queue@` 可进入队列，包含 `+fail@` 可模拟投递失败；如果后端启用了 Cloudflare 原生发信，请优先用已验证地址做通知测试。
          </p>
        </div>
        <div class="flex gap-2">
          <button
            class="rounded-full border border-night/10 px-4 py-2 text-sm text-ink transition hover:border-night/20"
            onclick={onClose}
            type="button"
          >
            取消
          </button>
          <button
            class="rounded-full border border-night/10 px-4 py-2 text-sm text-ink transition hover:border-accent hover:text-accent disabled:opacity-60"
            disabled={pending}
            onclick={saveDraft}
            type="button"
          >
            {pending ? '保存中…' : saveLabel}
          </button>
          <button
            class="rounded-full bg-ink px-4 py-2 text-sm text-paper transition hover:bg-accent disabled:opacity-60"
            disabled={pending}
            type="submit"
          >
            {pending ? '发送中…' : sendLabel}
          </button>
        </div>
      </div>
    </form>
  </div>
</div>
