<script lang="ts">
  import { validateComposeInput } from '$lib/domain/mail';
  import { Button, Dialog, TextArea, TextField } from '$lib/components/ui';
  import type { ComposeInput, ComposeMode, MailMessage, UserProfile } from '$lib/domain/mail';
  import { withComposePersistence } from '$lib/client/compose-controller';
  import { onMount } from 'svelte';

  const createComposeState = (value: ComposeInput | null, fallbackDraftId?: string): ComposeInput =>
    value
      ? {
          ...value,
          draftId: value.draftId ?? fallbackDraftId,
          cc: value.cc ?? ''
        }
      : {
          draftId: fallbackDraftId,
          toEmail: '',
          cc: '',
          subject: '',
          body: ''
        };

  const serializeComposeInput = (value: ComposeInput) =>
    JSON.stringify({
      draftId: value.draftId ?? null,
      toEmail: value.toEmail,
      cc: value.cc ?? '',
      subject: value.subject,
      body: value.body,
      messageId: value.messageId ?? null,
      inReplyTo: value.inReplyTo ?? null,
      references: value.references ?? null
    });

  let {
    initialInput = null,
    draftId = undefined,
    expectedUpdatedAt = undefined,
    mode = 'new',
    profile,
    senderEmail = null,
    pending = false,
    autosaveStatus = 'idle',
    autosaveMessage = '自动保存会在停顿后触发。',
    onClose,
    onDiscard,
    onInputChange,
    onSaveDraft,
    onSend,
    draftConflict = null,
    localEditedAt = null,
    onLoadServerDraft,
    onSaveDraftCopy,
    onOverwriteServerDraft
  }: {
    initialInput?: ComposeInput | null;
    draftId?: string | undefined;
    mode?: ComposeMode;
    profile: UserProfile;
    senderEmail?: string | null;
    pending?: boolean;
    autosaveStatus?: 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
    autosaveMessage?: string;
    expectedUpdatedAt?: string | undefined;
    onClose: (input: ComposeInput) => void | Promise<void>;
    /** Optional discard path; the parent can clear the live compose state without autosaving. */
    onDiscard?: () => void;
    onInputChange?: (input: ComposeInput) => void;
    onSaveDraft: (input: ComposeInput) => void | Promise<void>;
    onSend: (input: ComposeInput) => void | Promise<void>;
    draftConflict?: MailMessage | null;
    localEditedAt?: string | null;
    onLoadServerDraft?: () => void;
    onSaveDraftCopy?: () => void | Promise<void>;
    onOverwriteServerDraft?: () => void | Promise<void>;
  } = $props();

  let input = $state<ComposeInput>(createComposeState(null));
  let baseline = $state('');
  let touched = $state<Record<string, boolean>>({});
  let attempted = $state(false);
  let showCc = $state(false);
  let showCloseConfirm = $state(false);

  $effect(() => {
    const next = createComposeState(initialInput, initialInput?.draftId);
    input = next;
    baseline = serializeComposeInput(next);
    touched = {};
    attempted = false;
    showCc = Boolean(next.cc?.trim());
  });

  $effect(() => {
    if (
      (draftId && input.draftId !== draftId) ||
      (expectedUpdatedAt && input.expectedUpdatedAt !== expectedUpdatedAt)
    ) {
      input = withComposePersistence(input, { draftId, expectedUpdatedAt });
    }
  });

  $effect(() => {
    if (autosaveStatus === 'saved') {
      baseline = serializeComposeInput(input);
    }
  });

  const title = $derived(
    mode === 'new' ? '新邮件' : mode === 'reply' ? '回复邮件' : mode === 'forward' ? '转发邮件' : '编辑草稿'
  );
  const validation = $derived(validateComposeInput(input));
  const isEmpty = $derived(!input.toEmail.trim() && !input.cc?.trim() && !input.subject.trim() && !input.body.trim());
  const isDirty = $derived(
    !isEmpty &&
      (serializeComposeInput(input) !== baseline ||
        autosaveStatus === 'dirty' ||
        autosaveStatus === 'saving' ||
        autosaveStatus === 'error')
  );
  const sendDisabled = $derived(pending || !validation.ok);
  const autosaveTone = $derived(
    autosaveStatus === 'error'
      ? 'text-[var(--fm-danger)]'
      : autosaveStatus === 'saved'
        ? 'text-[var(--fm-success)]'
        : autosaveStatus === 'saving'
          ? 'text-[var(--fm-warning)]'
          : 'text-[var(--fm-text-muted)]'
  );

  function fieldError(field: string): string | undefined {
    if (!attempted && !touched[field]) return undefined;
    return validation.issues.find((issue) => issue.field === field)?.message;
  }

  function updateInput<K extends keyof ComposeInput>(key: K, value: ComposeInput[K]) {
    const next = { ...input, [key]: value };
    input = next;
    touched = { ...touched, [String(key)]: true };
    onInputChange?.(next);
  }

  function requestClose() {
    if (showCloseConfirm) return;
    if (isDirty) {
      showCloseConfirm = true;
      return;
    }
    void onClose(input);
  }

  function saveAndClose() {
    showCloseConfirm = false;
    void onClose(input);
  }

  function discardAndClose() {
    showCloseConfirm = false;
    if (onDiscard) {
      onDiscard();
      return;
    }
    // Kept as a compatibility fallback. Parents that autosave in onClose should provide onDiscard.
    void onClose(input);
  }

  function handleShortcut(event: KeyboardEvent) {
    const dialog = document.querySelector('.compose-dialog');
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && dialog?.contains(event.target as Node)) {
      event.preventDefault();
      attempted = true;
      if (!sendDisabled) void onSend(input);
    }
  }

  onMount(() => {
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  });
</script>

<Dialog
  open
  {title}
  description={profile.email}
  size="xl"
  class="compose-dialog !max-w-[56rem] max-sm:fixed max-sm:inset-0 max-sm:h-[100dvh] max-sm:max-h-none max-sm:w-screen max-sm:max-w-none max-sm:rounded-none"
  closeOnBackdrop={false}
  onClose={requestClose}
>
  <form class="flex min-h-[34rem] flex-col gap-5 max-sm:min-h-0" onsubmit={(event) => event.preventDefault()}>
    <div class="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] px-3 py-2.5 text-xs text-[var(--fm-text-secondary)]">
      <span>工作区身份：<strong class="font-medium text-[var(--fm-text)]">{profile.name || profile.email}</strong> &lt;{profile.email}&gt;</span>
      <span class="hidden shrink-0 sm:inline">实际投递：{senderEmail ?? '尚未配置'} · 纯文本</span>
    </div>

    <div class="grid gap-4">
      <TextField
        id="compose-to"
        label="收件人"
        type="email"
        required
        autocomplete="email"
        placeholder="name@example.com"
        value={input.toEmail}
        error={fieldError('toEmail')}
        oninput={(event) => updateInput('toEmail', event.currentTarget.value)}
      />

      <div class="grid gap-2">
        {#if showCc}
          <TextField
            id="compose-cc"
            label="抄送"
            hint="多个地址可使用逗号、分号或空格分隔。"
            placeholder="optional@example.com"
            value={input.cc ?? ''}
            error={fieldError('cc')}
            oninput={(event) => updateInput('cc', event.currentTarget.value)}
          />
        {:else}
          <button
            class="w-fit rounded-[var(--radius-md)] px-1 py-1 text-xs font-medium text-[var(--fm-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fm-focus)]"
            type="button"
            aria-expanded="false"
            onclick={() => (showCc = true)}
          >
            添加抄送
          </button>
        {/if}
      </div>

      <TextField
        id="compose-subject"
        label="主题"
        required
        placeholder="输入邮件主题"
        value={input.subject}
        error={fieldError('subject')}
        oninput={(event) => updateInput('subject', event.currentTarget.value)}
      />
    </div>

    <TextArea
      id="compose-body"
      label="正文"
      required
      rows={12}
      placeholder="在这里撰写正文…"
      value={input.body}
      error={fieldError('body')}
      class="min-h-[18rem] flex-1 max-sm:min-h-[12rem]"
      oninput={(event) => updateInput('body', event.currentTarget.value)}
    />

    {#if attempted && !validation.ok}
      <p class="rounded-[var(--radius-md)] border border-[var(--fm-danger)]/30 bg-[var(--fm-danger-soft)] px-3 py-2 text-xs text-[var(--fm-danger)]" role="alert">
        请修正标记的字段后再发送。
      </p>
    {/if}
    {#if draftConflict}
      <div class="grid gap-2 rounded-[var(--radius-md)] border border-[var(--fm-warning)]/40 bg-[var(--fm-warning-soft)] px-3 py-3 text-sm text-[var(--fm-text)]" role="alert">
        <strong>服务器版本已更新</strong>
        <span class="text-xs text-[var(--fm-text-secondary)]">本地编辑时间：{localEditedAt ? new Date(localEditedAt).toLocaleString('zh-CN') : '刚刚'}；服务器版本：{draftConflict.sentAt ? new Date(draftConflict.sentAt).toLocaleString('zh-CN') : '未知'}。你的本地编辑仍然保留。</span>
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onclick={() => onLoadServerDraft?.()}>载入服务器版本</Button>
          <Button variant="outline" size="sm" onclick={() => onSaveDraftCopy?.()}>另存为新草稿</Button>
          <Button variant="primary" size="sm" onclick={() => onOverwriteServerDraft?.()}>明确覆盖</Button>
        </div>
      </div>
    {/if}
  </form>

  {#snippet footer()}
    <div class="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <Button variant="ghost" size="sm" disabled={pending} onclick={() => onSaveDraft(input)}>保存草稿</Button>
        <span class={`truncate text-xs ${autosaveTone}`} role="status" aria-live="polite">{autosaveMessage}</span>
        <span class="hidden text-[11px] text-[var(--fm-text-muted)] md:inline"><kbd class="rounded border border-[var(--fm-border)] px-1 py-0.5 font-mono">⌘/Ctrl + Enter</kbd> 发送</span>
      </div>
      <div class="flex shrink-0 items-center justify-end gap-2 pb-[env(safe-area-inset-bottom)] sm:pb-0">
        <Button variant="outline" disabled={pending} onclick={requestClose}>取消</Button>
        <Button variant="primary" loading={pending} disabled={sendDisabled} onclick={() => { attempted = true; if (!sendDisabled) void onSend(input); }}>发送邮件</Button>
      </div>
    </div>
  {/snippet}
</Dialog>

{#if showCloseConfirm}
  <Dialog
    open
    title="未保存的改动"
    description="这封邮件还有未保存内容。请选择离开方式。"
    size="sm"
    onClose={() => (showCloseConfirm = false)}
  >
    <p class="text-sm leading-6 text-[var(--fm-text-secondary)]">保存后可以在草稿箱继续编辑；放弃改动将永久丢失当前内容。</p>
    {#snippet footer()}
      <div class="flex w-full flex-wrap justify-end gap-2">
        <Button variant="ghost" onclick={() => (showCloseConfirm = false)}>继续编辑</Button>
        <Button variant="outline" onclick={saveAndClose}>保存并关闭</Button>
        <Button variant="danger" onclick={discardAndClose}>放弃改动</Button>
      </div>
    {/snippet}
  </Dialog>
{/if}
