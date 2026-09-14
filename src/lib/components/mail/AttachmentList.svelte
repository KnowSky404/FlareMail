<script lang="ts">
  import { Download, File, FileArchive, FileImage, FileText, LoaderCircle } from '@lucide/svelte';
  import type { MailAttachmentSummary } from '$lib/domain/mail';
  import { formatNumber } from '$lib/i18n';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    attachments = [],
    loading = false,
    error = '',
    emptyLabel
  }: {
    attachments?: MailAttachmentSummary[];
    loading?: boolean;
    error?: string;
    emptyLabel?: string;
  } = $props();

  const i18n = useLocale();
  const { t } = i18n;

  const formatBytes = (value: number) => {
    if (value < 1024) return `${formatNumber(value, i18n.locale)} B`;
    if (value < 1024 * 1024) return `${formatNumber(value / 1024, i18n.locale, { maximumFractionDigits: 1 })} KB`;
    return `${formatNumber(value / (1024 * 1024), i18n.locale, { maximumFractionDigits: 1 })} MB`;
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
    <h2 id="attachments-title" class="text-sm font-semibold text-[var(--fm-text)]">{t('mail.attachments')} <span class="font-normal text-[var(--fm-text-muted)]">({formatNumber(attachments.length, i18n.locale)})</span></h2>
    {#if loading}<span class="inline-flex items-center gap-1 text-xs text-[var(--fm-text-muted)]" role="status"><LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />{t('common.loading')}</span>{/if}
  </div>
  {#if error}
    <p class="mt-3 rounded-[var(--radius-md)] border border-[var(--fm-danger)]/35 bg-[var(--fm-danger-soft)] px-3 py-2 text-xs text-[var(--fm-danger)]" role="alert">{error}</p>
  {:else if loading && attachments.length === 0}
    <p class="mt-3 text-xs text-[var(--fm-text-muted)]">{t('mail.loadingAttachmentSummary')}</p>
  {:else if attachments.length === 0}
    <p class="mt-3 text-xs text-[var(--fm-text-muted)]">{emptyLabel ?? t('mail.noAttachments')}</p>
  {:else}
    <ul class="mt-3 grid gap-2 sm:grid-cols-2" aria-label={t('mail.attachmentList')}>
      {#each attachments as attachment (attachment.id ?? `${attachment.filename}-${attachment.size}`)}
        {@const AttachmentIcon = iconFor(attachment.contentType)}
        {@const href = safeHref(attachment.downloadUrl)}
        <li class="flex min-w-0 items-center gap-3 rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] px-3 py-3">
          <span class="grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--fm-surface)] text-[var(--fm-primary)]" aria-hidden="true"><AttachmentIcon class="size-4" /></span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-[var(--fm-text)]" title={attachment.filename}>{attachment.filename}</p>
            <p class="mt-0.5 truncate text-xs text-[var(--fm-text-muted)]">{attachment.contentType} · {formatBytes(attachment.size)}{attachment.inline ? ` · ${t('mail.inlineResource')}` : ''}</p>
          </div>
          {#if href}
            <a class="grid size-11 shrink-0 place-items-center rounded-[var(--radius-md)] text-[var(--fm-primary)] hover:bg-[var(--fm-primary-soft)]" href={href} download={attachment.filename} rel="noopener noreferrer" aria-label={t('mail.downloadAttachmentWithName', { filename: attachment.filename })} title={t('mail.downloadAttachment')}>
              <Download class="size-4" aria-hidden="true" />
            </a>
          {:else}
            <span class="text-[11px] text-[var(--fm-text-muted)]" title={t('mail.downloadUnavailable')}>{t('mail.downloadUnavailable')}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
