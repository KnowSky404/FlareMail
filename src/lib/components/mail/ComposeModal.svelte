<script lang="ts">
  import {
    inspectAddressList,
    parseAddressList,
    validateComposeInput,
    type MailAddress,
    type MailAddressInput
  } from '$lib/domain/mail';
  import { Paperclip, RefreshCw, Trash2, Upload, X } from '@lucide/svelte';
  import { Button, Dialog, TextArea, TextField } from '$lib/components/ui';
  import type { ComposeInput, ComposeMode, MailMessage, UserProfile } from '$lib/domain/mail';
  import { withComposePersistence } from '$lib/client/compose-controller';
  import {
    deleteDraftAttachment,
    renameDraftAttachment,
    uploadDraftAttachment,
    type DraftAttachmentResponse
  } from '$lib/client/workspace-api';
  import { onMount } from 'svelte';

  const createComposeState = (value: ComposeInput | null, fallbackDraftId?: string): ComposeInput => ({
    ...(value ?? {}),
    draftId: value?.draftId ?? fallbackDraftId,
    to: parseAddressList(value?.to ?? value?.toEmail ?? ''),
    cc: parseAddressList(value?.cc ?? ''),
    bcc: parseAddressList(value?.bcc ?? ''),
    toEmail: value?.toEmail ?? '',
    subject: value?.subject ?? '',
    body: value?.body ?? '',
    html: value?.html ?? '',
    attachments: value?.attachments ?? [],
    attachmentRevision: value?.attachmentRevision ?? 0
  });

  const serializeComposeInput = (value: ComposeInput) =>
    JSON.stringify({
      draftId: value.draftId ?? null,
      bodyRevision: value.bodyRevision ?? null,
      to: parseAddressList(value.to ?? value.toEmail ?? ''),
      cc: parseAddressList(value.cc ?? ''),
      bcc: parseAddressList(value.bcc ?? ''),
      toEmail: value.toEmail ?? '',
      subject: value.subject,
      body: value.body,
      html: value.html ?? '',
      attachmentIds: (value.attachments ?? []).map((attachment) => attachment.id).filter(Boolean),
      attachmentRevision: value.attachmentRevision ?? 0,
      messageId: value.messageId ?? null,
      inReplyTo: value.inReplyTo ?? null,
      references: value.references ?? null
    });

  let {
    initialInput = null,
    draftId = undefined,
    expectedUpdatedAt = undefined,
    bodyRevision = undefined,
    mode = 'new',
    profile,
    senderEmail = null,
    pending = false,
    autosaveStatus = 'idle',
    autosaveMessage = '自动保存会在停顿后触发。',
    onClose,
    onDiscard,
    onInputChange,
    onPrepareAttachments,
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
    bodyRevision?: string | null | undefined;
    onClose: (input: ComposeInput) => void | Promise<void>;
    /** Optional discard path; the parent can clear the live compose state without autosaving. */
    onDiscard?: () => void;
    onInputChange?: (input: ComposeInput) => void;
    onPrepareAttachments?: (input: ComposeInput) => Promise<ComposeInput>;
    onSaveDraft: (input: ComposeInput) => void | Promise<void>;
    onSend: (input: ComposeInput) => void | Promise<void>;
    draftConflict?: Pick<MailMessage, 'id' | 'sentAt'> | null;
    localEditedAt?: string | null;
    onLoadServerDraft?: () => void | Promise<void>;
    onSaveDraftCopy?: () => void | Promise<void>;
    onOverwriteServerDraft?: () => void | Promise<void>;
  } = $props();

  let input = $state<ComposeInput>(createComposeState(null));
  let baseline = $state('');
  let touched = $state<Record<string, boolean>>({});
  let attempted = $state(false);
  let showCc = $state(false);
  let showBcc = $state(false);
  let recipientDraft = $state({ to: '', cc: '', bcc: '' });
  let recipientCommitTimers: Partial<Record<'to' | 'cc' | 'bcc', ReturnType<typeof setTimeout>>> = {};
  let showCloseConfirm = $state(false);
  let fileInput = $state<HTMLInputElement>();
  let retryFileInput = $state<HTMLInputElement>();
  let retryAttachmentId = $state<string | null>(null);
  let dragActive = $state(false);
  let attachmentMutationError = $state('');
  let forwardAttachmentImporting = $state(false);
  let attachmentTasks = $state<Array<{
    id: string;
    file: File;
    progress: number;
    state: 'queued' | 'uploading' | 'failed';
    error: string;
    cancel?: () => void;
  }>>([]);
  let renameValues = $state<Record<string, string>>({});

  $effect(() => {
    const next = createComposeState(initialInput, initialInput?.draftId);
    input = next;
    baseline = serializeComposeInput(next);
    touched = {};
    attempted = false;
    showCc = Array.isArray(next.cc) && next.cc.length > 0;
    showBcc = Array.isArray(next.bcc) && next.bcc.length > 0;
    recipientDraft = { to: '', cc: '', bcc: '' };
    attachmentTasks = [];
    attachmentMutationError = '';
    renameValues = Object.fromEntries((next.attachments ?? []).flatMap((attachment) => attachment.id ? [[attachment.id, attachment.filename]] : []));
  });

  $effect(() => {
    if (
      (draftId && input.draftId !== draftId) ||
      (expectedUpdatedAt && input.expectedUpdatedAt !== expectedUpdatedAt) ||
      (bodyRevision !== undefined && input.bodyRevision !== (bodyRevision ?? undefined))
    ) {
      input = withComposePersistence(input, {
        draftId,
        expectedUpdatedAt,
        ...(bodyRevision !== undefined ? { bodyRevision } : {})
      });
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
  const inputWithRecipientDrafts = $derived.by(() => {
    const next = { ...input };
    for (const field of ['to', 'cc', 'bcc'] as const) {
      const current = Array.isArray(input[field])
        ? [...input[field] as MailAddressInput[]]
        : [input[field] ?? (field === 'to' ? input.toEmail ?? '' : '')].filter(Boolean) as MailAddressInput[];
      const pendingRecipient = recipientDraft[field].trim();
      next[field] = pendingRecipient ? [...current, pendingRecipient] : current;
    }
    return next;
  });
  const validation = $derived(validateComposeInput(inputWithRecipientDrafts));
  const hasPendingRecipient = $derived(Object.values(recipientDraft).some((value) => value.trim().length > 0));
  const isEmpty = $derived(!(Array.isArray(inputWithRecipientDrafts.to) ? inputWithRecipientDrafts.to.length : parseAddressList(inputWithRecipientDrafts.to ?? inputWithRecipientDrafts.toEmail ?? '').length) && !(Array.isArray(inputWithRecipientDrafts.cc) ? inputWithRecipientDrafts.cc.length : parseAddressList(inputWithRecipientDrafts.cc ?? '').length) && !(Array.isArray(inputWithRecipientDrafts.bcc) ? inputWithRecipientDrafts.bcc.length : parseAddressList(inputWithRecipientDrafts.bcc ?? '').length) && !inputWithRecipientDrafts.subject.trim() && !inputWithRecipientDrafts.body.trim() && !inputWithRecipientDrafts.html?.trim() && !(inputWithRecipientDrafts.attachments?.length) && attachmentTasks.length === 0);
  const isDirty = $derived(
    !isEmpty &&
      (hasPendingRecipient ||
        serializeComposeInput(inputWithRecipientDrafts) !== baseline ||
        autosaveStatus === 'dirty' ||
        autosaveStatus === 'saving' ||
        autosaveStatus === 'error')
  );
  const attachmentBusy = $derived(attachmentTasks.some((task) => task.state !== 'failed'));
  const attachmentFailed = $derived(attachmentTasks.some((task) => task.state === 'failed'));
  const persistedAttachmentBlocked = $derived((input.attachments ?? []).some((attachment) => attachment.state && attachment.state !== 'ready'));
  const sendDisabled = $derived(pending || forwardAttachmentImporting || attachmentBusy || attachmentFailed || persistedAttachmentBlocked || !validation.ok);
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

  function applyAttachmentResult(result: DraftAttachmentResponse) {
    attachmentMutationError = '';
    const next = {
      ...input,
      attachments: result.attachments,
      attachmentRevision: result.attachmentRevision,
      expectedUpdatedAt: result.draftUpdatedAt
    };
    input = next;
    renameValues = Object.fromEntries(result.attachments.flatMap((attachment) => attachment.id ? [[attachment.id, attachment.filename]] : []));
    onInputChange?.(next);
  }

  function updateAttachmentTask(id: string, patch: Partial<(typeof attachmentTasks)[number]>) {
    attachmentTasks = attachmentTasks.map((task) => task.id === id ? { ...task, ...patch } : task);
  }

  async function preparedAttachmentInput() {
    if (!onPrepareAttachments) throw new Error('草稿附件服务暂不可用。');
    const prepared = await onPrepareAttachments(inputWithRecipientDrafts);
    input = createComposeState(prepared, prepared.draftId);
    onInputChange?.(input);
    return input;
  }

  async function startAttachmentUpload(id: string, file: File) {
    if (!attachmentTasks.some((task) => task.id === id)) {
      attachmentTasks = [...attachmentTasks, { id, file, progress: 0, state: 'queued', error: '' }];
    }
    updateAttachmentTask(id, { state: 'uploading', progress: 0, error: '' });
    try {
      const prepared = await preparedAttachmentInput();
      if (!prepared.draftId) throw new Error('无法创建附件所属草稿。');
      const operation = uploadDraftAttachment(
        prepared.draftId,
        id,
        file,
        prepared.attachmentRevision ?? 0,
        (progress) => updateAttachmentTask(id, { progress })
      );
      updateAttachmentTask(id, { cancel: operation.cancel });
      const result = await operation.promise;
      applyAttachmentResult(result);
      attachmentTasks = attachmentTasks.filter((task) => task.id !== id);
      return true;
    } catch (error) {
      updateAttachmentTask(id, {
        state: 'failed',
        cancel: undefined,
        error: error instanceof Error ? error.message : '附件上传失败。'
      });
      return false;
    }
  }

  function excludeForwardAttachments() {
    updateInput('forwardAttachmentCandidates', undefined);
  }

  async function includeForwardAttachments() {
    const candidates = [...input.forwardAttachmentCandidates ?? []];
    if (!candidates.length || forwardAttachmentImporting) return;
    forwardAttachmentImporting = true;
    attachmentMutationError = '';
    try {
      for (const candidate of candidates) {
        const activeAttachments = (input.attachments ?? []).filter((attachment) => !attachment.state || attachment.state === 'ready');
        const activeBytes = activeAttachments.reduce((sum, attachment) => sum + attachment.size, 0);
        if (activeAttachments.length >= 10 || candidate.size > 8 * 1024 * 1024 || activeBytes + candidate.size > 12 * 1024 * 1024) {
          throw new Error(`原附件 ${candidate.filename} 超过数量、单文件 8 MB 或总计 12 MB 限制。`);
        }
        if (!candidate.downloadUrl?.startsWith('/api/workspace/messages/')) {
          throw new Error(`原附件 ${candidate.filename} 没有可用的安全下载地址。`);
        }
        const response = await fetch(candidate.downloadUrl, { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error(`无法读取原附件 ${candidate.filename}。`);
        const blob = await response.blob();
        if (blob.size !== candidate.size) throw new Error(`原附件 ${candidate.filename} 的大小校验失败。`);
        const file = new File([blob], candidate.filename, { type: candidate.contentType || blob.type || 'application/octet-stream' });
        const id = crypto.randomUUID();
        attachmentTasks = [...attachmentTasks, { id, file, progress: 0, state: 'queued', error: '' }];
        if (!(await startAttachmentUpload(id, file))) {
          throw new Error(`原附件 ${candidate.filename} 上传失败，可在附件列表中重试。`);
        }
        const remaining = (input.forwardAttachmentCandidates ?? []).filter(
          (item) => item.id !== candidate.id || item.downloadUrl !== candidate.downloadUrl
        );
        updateInput('forwardAttachmentCandidates', remaining.length ? remaining : undefined);
      }
    } catch (error) {
      attachmentMutationError = error instanceof Error ? error.message : '包含原附件失败。';
    } finally {
      forwardAttachmentImporting = false;
    }
  }

  async function addFiles(files: File[]) {
    const existing = input.attachments?.length ?? 0;
    const queued = attachmentTasks.length;
    const currentBytes = (input.attachments ?? []).reduce((sum, attachment) => sum + attachment.size, 0);
    let acceptedBytes = 0;
    let acceptedCount = 0;
    for (const file of files) {
      if (existing + queued + acceptedCount >= 10 || file.size > 8 * 1024 * 1024 || currentBytes + acceptedBytes + file.size > 12 * 1024 * 1024) {
        const id = crypto.randomUUID();
        attachmentTasks = [...attachmentTasks, { id, file, progress: 0, state: 'failed', error: '附件超过数量、单文件 8 MB 或总计 12 MB 限制。' }];
        continue;
      }
      acceptedBytes += file.size;
      acceptedCount += 1;
      const id = crypto.randomUUID();
      attachmentTasks = [...attachmentTasks, { id, file, progress: 0, state: 'queued', error: '' }];
      await startAttachmentUpload(id, file);
    }
    if (fileInput) fileInput.value = '';
  }

  async function cancelAttachmentTask(task: (typeof attachmentTasks)[number]) {
    task.cancel?.();
    const draftId = input.draftId;
    if (draftId) {
      try {
        applyAttachmentResult(await deleteDraftAttachment(draftId, task.id, input.attachmentRevision ?? 0));
        attachmentTasks = attachmentTasks.filter((candidate) => candidate.id !== task.id);
      } catch (error) {
        const message = error instanceof Error
          ? `取消状态未确认：${error.message}`
          : '取消状态未确认，请重新打开草稿后重试。';
        updateAttachmentTask(task.id, { state: 'failed', cancel: undefined, error: message });
        attachmentMutationError = message;
      }
      return;
    }
    attachmentTasks = attachmentTasks.filter((candidate) => candidate.id !== task.id);
  }

  function choosePersistedRetry(attachmentId: string) {
    retryAttachmentId = attachmentId;
    retryFileInput?.click();
  }

  function retryPersistedAttachment(file: File | undefined) {
    const attachmentId = retryAttachmentId;
    retryAttachmentId = null;
    if (retryFileInput) retryFileInput.value = '';
    if (attachmentId && file) void startAttachmentUpload(attachmentId, file);
  }

  async function removeAttachment(attachmentId: string) {
    if (!input.draftId) return;
    try {
      applyAttachmentResult(await deleteDraftAttachment(input.draftId, attachmentId, input.attachmentRevision ?? 0));
    } catch (error) {
      attachmentMutationError = error instanceof Error ? error.message : '删除附件失败，请重新载入草稿后重试。';
    }
  }

  async function renameAttachment(attachmentId: string) {
    if (!input.draftId) return;
    const filename = renameValues[attachmentId]?.trim() ?? '';
    try {
      applyAttachmentResult(await renameDraftAttachment(input.draftId, attachmentId, filename, input.attachmentRevision ?? 0));
    } catch (error) {
      attachmentMutationError = error instanceof Error ? error.message : '重命名附件失败，请重新载入草稿后重试。';
    }
  }

  function pastedFiles(event: ClipboardEvent) {
    const files = [...event.clipboardData?.files ?? []];
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  }

  function clearRecipientCommitTimer(field: 'to' | 'cc' | 'bcc') {
    const timer = recipientCommitTimers[field];
    if (timer) clearTimeout(timer);
    delete recipientCommitTimers[field];
  }

  function updateRecipientDraft(field: 'to' | 'cc' | 'bcc', value: string) {
    recipientDraft = { ...recipientDraft, [field]: value };
    clearRecipientCommitTimer(field);
    const entries = inspectAddressList(value);
    if (!value.trim() || entries.length === 0 || entries.some((entry) => !entry.address)) return;
    recipientCommitTimers[field] = setTimeout(() => {
      if (recipientDraft[field] === value) commitRecipient(field);
    }, 1_000);
  }

  function commitRecipient(field: 'to' | 'cc' | 'bcc') {
    clearRecipientCommitTimer(field);
    const value = recipientDraft[field].trim();
    if (!value) return;
    const entries = inspectAddressList(value);
    if (entries.some((entry) => !entry.address)) {
      touched = { ...touched, [field]: true };
      return;
    }
    const nextAddresses = entries.flatMap((entry) => entry.address ? [entry.address] : []);
    const current = Array.isArray(input[field]) ? input[field] as MailAddress[] : parseAddressList(input[field] as string | undefined);
    updateInput(field, [...current, ...nextAddresses]);
    recipientDraft = { ...recipientDraft, [field]: '' };
  }

  function pasteRecipients(field: 'to' | 'cc' | 'bcc', event: ClipboardEvent) {
    clearRecipientCommitTimer(field);
    const pasted = event.clipboardData?.getData('text/plain') ?? '';
    if (!pasted || !/[,;，；\r\n]/u.test(pasted)) return;
    event.preventDefault();
    const combined = [recipientDraft[field].trim(), pasted.trim()].filter(Boolean).join(', ');
    const current = Array.isArray(input[field]) ? input[field] as MailAddress[] : parseAddressList(input[field] as string | undefined);
    const entries = inspectAddressList(combined);
    if (entries.some((entry) => !entry.address)) {
      recipientDraft = { ...recipientDraft, [field]: combined };
      touched = { ...touched, [field]: true };
      return;
    }
    updateInput(field, [...current, ...entries.flatMap((entry) => entry.address ? [entry.address] : [])]);
    recipientDraft = { ...recipientDraft, [field]: '' };
  }

  function removeRecipient(field: 'to' | 'cc' | 'bcc', email: string) {
    const current = Array.isArray(input[field]) ? input[field] as MailAddress[] : parseAddressList(input[field] as string | undefined);
    updateInput(field, current.filter((address) => address.email !== email));
  }

  function requestClose() {
    if (showCloseConfirm) return;
    if (isDirty) {
      showCloseConfirm = true;
      return;
    }
    void onClose(inputWithRecipientDrafts);
  }

  function saveAndClose() {
    showCloseConfirm = false;
    void onClose(inputWithRecipientDrafts);
  }

  function discardAndClose() {
    showCloseConfirm = false;
    if (onDiscard) {
      onDiscard();
      return;
    }
    // Kept as a compatibility fallback. Parents that autosave in onClose should provide onDiscard.
    void onClose(inputWithRecipientDrafts);
  }

  function handleShortcut(event: KeyboardEvent) {
    const dialog = document.querySelector('.compose-dialog');
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && dialog?.contains(event.target as Node)) {
      event.preventDefault();
      attempted = true;
      if (!sendDisabled) void onSend(validation.value);
    }
  }

  onMount(() => {
    window.addEventListener('keydown', handleShortcut);
    return () => {
      window.removeEventListener('keydown', handleShortcut);
      for (const field of ['to', 'cc', 'bcc'] as const) clearRecipientCommitTimer(field);
    };
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
  <form class="flex min-h-[34rem] flex-col gap-5 max-sm:min-h-0" onsubmit={(event) => event.preventDefault()} onpaste={pastedFiles}>
    <div class="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] px-3 py-2.5 text-xs text-[var(--fm-text-secondary)]">
      <span>工作区身份：<strong class="font-medium text-[var(--fm-text)]">{profile.name || profile.email}</strong> &lt;{profile.email}&gt;</span>
      <span class="hidden shrink-0 sm:inline">实际投递：{senderEmail ?? '尚未配置'} · 纯文本回退，可选 HTML</span>
    </div>

    <div class="grid gap-4">
      <div class="grid gap-2">
        <label class="text-sm font-medium text-[var(--fm-text)]" for="compose-to">收件人</label>
        <div class="flex min-h-11 flex-wrap items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface)] px-2 py-1.5 focus-within:border-[var(--fm-focus)]">
          {#each parseAddressList(input.to ?? input.toEmail ?? '') as address (address.email)}
            <span class="inline-flex items-center gap-1 rounded-full bg-[var(--fm-primary-soft)] px-2 py-1 text-xs text-[var(--fm-primary)]">{address.name || address.email}<button type="button" aria-label={`移除收件人 ${address.email}`} onclick={() => removeRecipient('to', address.email)}>×</button></span>
          {/each}
          <input id="compose-to" class="min-w-32 flex-1 border-0 bg-transparent px-1 py-1 text-sm outline-none" placeholder="name@example.com，回车添加" value={recipientDraft.to} oninput={(event) => updateRecipientDraft('to', event.currentTarget.value)} onpaste={(event) => pasteRecipients('to', event)} onkeydown={(event) => { if (event.key === 'Enter' || event.key === ',' || event.key === '，' || event.key === ';' || event.key === '；') { event.preventDefault(); commitRecipient('to'); } }} onblur={() => commitRecipient('to')} />
        </div>
        {#if fieldError('to') || fieldError('toEmail')}<p class="text-xs text-[var(--fm-danger)]">{fieldError('to') ?? fieldError('toEmail')}</p>{/if}
      </div>

      <div class="grid gap-2">
        {#if showCc}
          <label class="text-sm font-medium text-[var(--fm-text)]" for="compose-cc">抄送</label>
          <div class="flex min-h-11 flex-wrap items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface)] px-2 py-1.5 focus-within:border-[var(--fm-focus)]">
            {#each parseAddressList(input.cc ?? '') as address (address.email)}
              <span class="inline-flex items-center gap-1 rounded-full bg-[var(--fm-primary-soft)] px-2 py-1 text-xs text-[var(--fm-primary)]">{address.name || address.email}<button type="button" aria-label={`移除抄送 ${address.email}`} onclick={() => removeRecipient('cc', address.email)}>×</button></span>
            {/each}
            <input id="compose-cc" class="min-w-32 flex-1 border-0 bg-transparent px-1 py-1 text-sm outline-none" placeholder="回车添加；支持逗号、分号、换行" value={recipientDraft.cc} oninput={(event) => updateRecipientDraft('cc', event.currentTarget.value)} onpaste={(event) => pasteRecipients('cc', event)} onkeydown={(event) => { if (event.key === 'Enter' || event.key === ',' || event.key === '，' || event.key === ';' || event.key === '；') { event.preventDefault(); commitRecipient('cc'); } }} onblur={() => commitRecipient('cc')} />
          </div>
          {#if fieldError('cc')}<p class="text-xs text-[var(--fm-danger)]">{fieldError('cc')}</p>{/if}
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

      {#if showBcc}
        <div class="grid gap-2">
          <label class="text-sm font-medium text-[var(--fm-text)]" for="compose-bcc">密送</label>
          <div class="flex min-h-11 flex-wrap items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface)] px-2 py-1.5 focus-within:border-[var(--fm-focus)]">
            {#each parseAddressList(input.bcc ?? '') as address (address.email)}
              <span class="inline-flex items-center gap-1 rounded-full bg-[var(--fm-primary-soft)] px-2 py-1 text-xs text-[var(--fm-primary)]">{address.name || address.email}<button type="button" aria-label={`移除密送 ${address.email}`} onclick={() => removeRecipient('bcc', address.email)}>×</button></span>
            {/each}
            <input id="compose-bcc" class="min-w-32 flex-1 border-0 bg-transparent px-1 py-1 text-sm outline-none" placeholder="回车添加；支持逗号、分号、换行" value={recipientDraft.bcc} oninput={(event) => updateRecipientDraft('bcc', event.currentTarget.value)} onpaste={(event) => pasteRecipients('bcc', event)} onkeydown={(event) => { if (event.key === 'Enter' || event.key === ',' || event.key === '，' || event.key === ';' || event.key === '；') { event.preventDefault(); commitRecipient('bcc'); } }} onblur={() => commitRecipient('bcc')} />
          </div>
          {#if fieldError('bcc')}<p class="text-xs text-[var(--fm-danger)]">{fieldError('bcc')}</p>{/if}
        </div>
      {:else}
        <button class="w-fit rounded-[var(--radius-md)] px-1 py-1 text-xs font-medium text-[var(--fm-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fm-focus)]" type="button" onclick={() => (showBcc = true)}>添加密送</button>
      {/if}

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

    <TextArea
      id="compose-html"
      label="HTML 源码（可选）"
      hint="可选 HTML 源码；允许的标签会在服务端清洗。不填写时使用纯文本正文。"
      rows={8}
      placeholder="例如：<p>你好，<strong>世界</strong>。</p>"
      value={input.html ?? ''}
      error={fieldError('html')}
      class="min-h-[10rem] max-w-full font-mono text-xs"
      oninput={(event) => updateInput('html', event.currentTarget.value)}
    />

    <section class="grid gap-3" aria-labelledby="compose-attachments-title">
      <div class="flex items-center justify-between gap-3">
        <h2 id="compose-attachments-title" class="text-sm font-medium text-[var(--fm-text)]">附件 <span class="font-normal text-[var(--fm-text-muted)]">({input.attachments?.length ?? 0}/10)</span></h2>
        <button class="inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 text-xs font-medium text-[var(--fm-primary)] hover:bg-[var(--fm-primary-soft)]" type="button" disabled={pending || attachmentBusy} onclick={() => fileInput?.click()}><Paperclip class="size-4" aria-hidden="true" />选择文件</button>
        <input bind:this={fileInput} class="sr-only" type="file" multiple aria-label="选择附件" onchange={(event) => void addFiles([...event.currentTarget.files ?? []])} />
        <input bind:this={retryFileInput} class="sr-only" type="file" aria-label="重新选择失败附件" onchange={(event) => retryPersistedAttachment(event.currentTarget.files?.[0])} />
      </div>
      <div
        class="grid min-h-20 place-items-center rounded-[var(--radius-md)] border border-dashed px-4 py-3 text-center text-xs text-[var(--fm-text-muted)]"
        class:border-[var(--fm-primary)]={dragActive}
        class:bg-[var(--fm-primary-soft)]={dragActive}
        role="button"
        tabindex="0"
        aria-label="拖放附件"
        ondragenter={(event) => { event.preventDefault(); dragActive = true; }}
        ondragover={(event) => event.preventDefault()}
        ondragleave={() => (dragActive = false)}
        ondrop={(event) => { event.preventDefault(); dragActive = false; void addFiles([...event.dataTransfer?.files ?? []]); }}
        onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInput?.click(); }}
      >
        <span><Upload class="mx-auto mb-1 size-4" aria-hidden="true" />拖入文件、粘贴图片或选择文件；单个 8 MB，总计 12 MB。</span>
      </div>
      {#if attachmentMutationError}
        <p class="rounded-[var(--radius-md)] border border-[var(--fm-danger)]/35 bg-[var(--fm-danger-soft)] px-3 py-2 text-xs text-[var(--fm-danger)]" role="alert">{attachmentMutationError}</p>
      {/if}
      {#if mode === 'forward' && input.forwardAttachmentCandidates?.length}
        <div class="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] px-3 py-2 text-xs">
          <span class="text-[var(--fm-text-secondary)]">原邮件有 {input.forwardAttachmentCandidates.length} 个附件，默认不包含。</span>
          <div class="flex gap-2">
            <button class="min-h-8 rounded px-2 text-[var(--fm-text-secondary)] hover:bg-[var(--fm-surface-hover)]" type="button" disabled={forwardAttachmentImporting} onclick={excludeForwardAttachments}>不包含</button>
            <button class="min-h-8 rounded px-2 font-medium text-[var(--fm-primary)] hover:bg-[var(--fm-primary-soft)]" type="button" disabled={forwardAttachmentImporting || attachmentBusy} onclick={() => void includeForwardAttachments()}>{forwardAttachmentImporting ? '正在包含…' : '包含原附件'}</button>
          </div>
        </div>
      {/if}
      {#if input.attachments?.length}
        <ul class="grid gap-2" aria-label="待发送附件">
          {#each input.attachments as attachment (attachment.id)}
            <li class="flex min-w-0 flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] px-3 py-2">
              <Paperclip class="size-4 shrink-0 text-[var(--fm-primary)]" aria-hidden="true" />
              <input class="fm-field min-w-32 flex-1 px-2 py-1 text-xs" aria-label={`附件名称 ${attachment.filename}`} disabled={attachment.state !== undefined && attachment.state !== 'ready'} value={attachment.id ? renameValues[attachment.id] ?? attachment.filename : attachment.filename} oninput={(event) => { if (attachment.id) renameValues = { ...renameValues, [attachment.id]: event.currentTarget.value }; }} />
              <span class="text-[11px] text-[var(--fm-text-muted)]">{(attachment.size / 1024).toFixed(1)} KB</span>
              {#if attachment.state && attachment.state !== 'ready'}<span class="text-[11px] text-[var(--fm-danger)]">{attachment.state === 'failed' ? '上传失败' : '上传未完成'}</span>{/if}
              {#if attachment.id && attachment.state === 'failed'}<button class="grid size-8 place-items-center rounded text-[var(--fm-primary)] hover:bg-[var(--fm-primary-soft)]" type="button" aria-label={`重新选择并上传 ${attachment.filename}`} onclick={() => choosePersistedRetry(attachment.id!)}><RefreshCw class="size-4" aria-hidden="true" /></button>{/if}
              {#if attachment.id && (!attachment.state || attachment.state === 'ready')}<button class="min-h-8 rounded px-2 text-xs text-[var(--fm-primary)] hover:bg-[var(--fm-primary-soft)]" type="button" onclick={() => void renameAttachment(attachment.id!)}>重命名</button>{/if}
              {#if attachment.id}<button class="grid size-8 place-items-center rounded text-[var(--fm-danger)] hover:bg-[var(--fm-danger-soft)]" type="button" aria-label={`删除附件 ${attachment.filename}`} onclick={() => void removeAttachment(attachment.id!)}><Trash2 class="size-4" aria-hidden="true" /></button>{/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if attachmentTasks.length}
        <ul class="grid gap-2" aria-label="附件上传状态">
          {#each attachmentTasks as task (task.id)}
            <li class="grid gap-1 rounded-[var(--radius-md)] border border-[var(--fm-border)] px-3 py-2 text-xs">
              <div class="flex items-center gap-2"><span class="min-w-0 flex-1 truncate">{task.file.name}</span><span>{task.state === 'failed' ? '失败' : `${task.progress}%`}</span>{#if task.state === 'failed'}<button class="grid size-8 place-items-center rounded text-[var(--fm-primary)] hover:bg-[var(--fm-primary-soft)]" type="button" aria-label={`重试上传 ${task.file.name}`} onclick={() => void startAttachmentUpload(task.id, task.file)}><RefreshCw class="size-4" aria-hidden="true" /></button>{/if}<button class="grid size-8 place-items-center rounded text-[var(--fm-danger)] hover:bg-[var(--fm-danger-soft)]" type="button" aria-label={`取消上传 ${task.file.name}`} onclick={() => void cancelAttachmentTask(task)}><X class="size-4" aria-hidden="true" /></button></div>
              {#if task.state === 'failed'}<p class="text-[var(--fm-danger)]" role="alert">{task.error}</p>{:else}<progress class="h-1.5 w-full" max="100" value={task.progress}>{task.progress}%</progress>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

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
        <Button variant="ghost" size="sm" disabled={pending} onclick={() => onSaveDraft(inputWithRecipientDrafts)}>保存草稿</Button>
        <span class={`truncate text-xs ${autosaveTone}`} role="status" aria-live="polite">{autosaveMessage}</span>
        <span class="hidden text-[11px] text-[var(--fm-text-muted)] md:inline"><kbd class="rounded border border-[var(--fm-border)] px-1 py-0.5 font-mono">⌘/Ctrl + Enter</kbd> 发送</span>
      </div>
      <div class="flex shrink-0 items-center justify-end gap-2 pb-[env(safe-area-inset-bottom)] sm:pb-0">
        <Button variant="outline" disabled={pending} onclick={requestClose}>取消</Button>
        <Button variant="primary" loading={pending} disabled={sendDisabled} onclick={() => { attempted = true; if (!sendDisabled) void onSend(validation.value); }}>发送邮件</Button>
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
