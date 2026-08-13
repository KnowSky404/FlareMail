<script lang="ts">
  import { Download, File, FileArchive, FileImage, FileText, LoaderCircle } from '@lucide/svelte';
  import type { MailAttachmentSummary } from '$lib/domain/mail';

  let {
    attachments = [],
    loading = false,
    error = '',
    emptyLabel = '当前邮件没有附件。'
  }: {
    attachments?: MailAttachmentSummary[];
    loading?: boolean;
    error?: string;
    emptyLabel?: string;
  } = $props();

  const formatBytes = (value: number) => {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  };

  const safeHref = (value: string | null | undefined) => {
    if (!value) return null;
    try {
      const url = new URL(value, 'https://flaremail.invalid');
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return value;
    } catch {
      return null;
    }
  };

  const iconFor = (contentType: string) => {
    if (contentType.startsWith('image/')) return FileImage;
    if (contentType.includes('pdf') || contentType.startsWith('text/')) return FileText;
    if (contentType.includes('zip') || contentType.includes('archive') || contentType.includes('compressed')) return FileArchive;
    return File;
  };
</script>

<section aria-labelledby="attachments-title" class="border-t border-[var(--fm-border)] pt-5">
  <div class="flex items-center justify-between gap-3">
    <h2 id="attachments-title" class="text-sm font-semibold text-[var(--fm-text)]">附件 <span class="font-normal text-[var(--fm-text-muted)]">({attachments.length})</span></h2>
    {#if loading}<span class="inline-flex items-center gap-1 text-xs text-[var(--fm-text-muted)]" role="status"><LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />载入中</span>{/if}
  </div>
  {#if error}
    <p class="mt-3 rounded-[var(--radius-md)] border border-[var(--fm-danger)]/35 bg-[var(--fm-danger-soft)] px-3 py-2 text-xs text-[var(--fm-danger)]" role="alert">{error}</p>
  {:else if loading && attachments.length === 0}
    <p class="mt-3 text-xs text-[var(--fm-text-muted)]">正在从归档读取附件摘要…</p>
  {:else if attachments.length === 0}
    <p class="mt-3 text-xs text-[var(--fm-text-muted)]">{emptyLabel}</p>
  {:else}
    <ul class="mt-3 grid gap-2 sm:grid-cols-2" aria-label="邮件附件列表">
      {#each attachments as attachment (attachment.id ?? `${attachment.filename}-${attachment.size}`)}
        {@const AttachmentIcon = iconFor(attachment.contentType)}
        {@const href = safeHref(attachment.downloadUrl)}
        <li class="flex min-w-0 items-center gap-3 rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] px-3 py-3">
          <span class="grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--fm-surface)] text-[var(--fm-primary)]" aria-hidden="true"><AttachmentIcon class="size-4" /></span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-[var(--fm-text)]" title={attachment.filename}>{attachment.filename}</p>
            <p class="mt-0.5 truncate text-xs text-[var(--fm-text-muted)]">{attachment.contentType} · {formatBytes(attachment.size)}{attachment.inline ? ' · 内联资源' : ''}</p>
          </div>
          {#if href}
            <a class="grid size-11 shrink-0 place-items-center rounded-[var(--radius-md)] text-[var(--fm-primary)] hover:bg-[var(--fm-primary-soft)]" href={href} download={attachment.filename} rel="noopener noreferrer" aria-label={`下载附件 ${attachment.filename}`} title="下载附件">
              <Download class="size-4" aria-hidden="true" />
            </a>
          {:else}
            <span class="text-[11px] text-[var(--fm-text-muted)]" title="下载链接不可用">不可下载</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
