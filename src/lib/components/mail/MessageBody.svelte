<script lang="ts">
  import { FileWarning, LoaderCircle } from '@lucide/svelte';

  let {
    body = '',
    loading = false,
    hasHtml = false,
    emptyLabel = '这封邮件没有正文。'
  }: {
    body?: string;
    loading?: boolean;
    hasHtml?: boolean;
    emptyLabel?: string;
  } = $props();
</script>

<section aria-labelledby="message-body-title" class="min-w-0">
  <h2 id="message-body-title" class="sr-only">邮件正文</h2>
  {#if loading}
    <div class="flex items-center gap-2 py-8 text-sm text-[var(--fm-text-muted)]" role="status" aria-live="polite">
      <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />正在载入邮件正文…
    </div>
  {:else if body}
    {#if hasHtml}
      <div class="mb-4 flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] px-3 py-2 text-xs text-[var(--fm-text-secondary)]" role="note">
        <FileWarning class="mt-0.5 size-4 shrink-0 text-[var(--fm-warning)]" aria-hidden="true" />
        <span>邮件包含 HTML 内容，当前以安全的纯文本视图显示。</span>
      </div>
    {/if}
    <div class="max-w-[76ch] whitespace-pre-wrap break-words text-[15px] leading-[1.75] text-[var(--fm-text)]">{body}</div>
  {:else}
    <p class="py-8 text-sm text-[var(--fm-text-muted)]">{emptyLabel}</p>
  {/if}
</section>
