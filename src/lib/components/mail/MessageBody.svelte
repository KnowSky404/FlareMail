<script lang="ts">
  import { ExternalLink, FileDown, FileWarning, ImageOff, LoaderCircle } from '@lucide/svelte';

  let {
    body = '',
    loading = false,
    hasHtml = false,
    emptyLabel = '这封邮件没有正文。',
    messageId = '',
    onReportIssue
  }: {
    body?: string;
    loading?: boolean;
    hasHtml?: boolean;
    emptyLabel?: string;
    messageId?: string;
    onReportIssue?: () => void;
  } = $props();

  let view = $state<'text' | 'html'>('text');
  let allowRemoteImages = $state(false);
  const htmlUrl = $derived(messageId ? `/api/workspace/messages/${encodeURIComponent(messageId)}/html?remote=${allowRemoteImages ? '1' : '0'}` : '');
  const printUrl = $derived(htmlUrl ? `${htmlUrl}&print=1` : '');

  function downloadDisplayReport() {
    if (!messageId || typeof document === 'undefined') return;
    const report = {
      version: 1,
      messageId,
      generatedAt: new Date().toISOString(),
      view,
      remoteImagesAllowed: allowRemoteImages,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      userAgent: navigator.userAgent
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `flaremail-html-display-${messageId.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 80)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    onReportIssue?.();
  }
</script>

<section aria-labelledby="message-body-title" class="min-w-0">
  <h2 id="message-body-title" class="sr-only">邮件正文</h2>
  {#if loading}
    <div class="flex items-center gap-2 py-8 text-sm text-[var(--fm-text-muted)]" role="status" aria-live="polite">
      <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />正在载入邮件正文…
    </div>
  {:else if body || hasHtml}
    {#if hasHtml}
      <div class="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--fm-border)] pb-3">
        <div class="inline-flex rounded-[var(--radius-md)] border border-[var(--fm-border)] p-0.5" role="group" aria-label="正文格式">
          <button class={`min-h-11 rounded-[calc(var(--radius-md)-2px)] px-3 text-xs font-medium sm:min-h-9 ${view === 'text' ? 'bg-[var(--fm-primary)] text-[var(--fm-text-inverse)]' : ''}`} type="button" aria-pressed={view === 'text'} onclick={() => (view = 'text')}>纯文本</button>
          <button class={`min-h-11 rounded-[calc(var(--radius-md)-2px)] px-3 text-xs font-medium sm:min-h-9 ${view === 'html' ? 'bg-[var(--fm-primary)] text-[var(--fm-text-inverse)]' : ''}`} type="button" aria-pressed={view === 'html'} onclick={() => (view = 'html')}>安全 HTML</button>
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
          {#if printUrl}
            <a class="inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 text-xs font-medium text-[var(--fm-text-secondary)] hover:bg-[var(--fm-surface-hover)] sm:min-h-9" href={printUrl} target="_blank" rel="noopener noreferrer"><ExternalLink class="size-3.5" aria-hidden="true" />打印视图</a>
          {/if}
          <button class="inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 text-xs font-medium text-[var(--fm-text-secondary)] hover:bg-[var(--fm-surface-hover)] sm:min-h-9" type="button" onclick={downloadDisplayReport}><FileDown class="size-3.5" aria-hidden="true" />下载显示问题报告</button>
        </div>
      </div>
    {/if}
    {#if hasHtml && view === 'html' && htmlUrl}
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] px-3 py-2 text-xs text-[var(--fm-text-secondary)]" role="note">
        <span class="flex min-w-0 items-start gap-2"><ImageOff class="mt-0.5 size-4 shrink-0 text-[var(--fm-warning)]" aria-hidden="true" /><span>远程图片默认阻止，以减少跟踪像素泄露 IP 和打开时间；CID 图片仅通过当前邮件的认证路由显示。</span></span>
        <button class="min-h-11 shrink-0 rounded-[var(--radius-md)] border border-[var(--fm-border)] px-2.5 font-medium hover:bg-[var(--fm-surface-hover)] sm:min-h-9" type="button" aria-pressed={allowRemoteImages} onclick={() => (allowRemoteImages = !allowRemoteImages)}>{allowRemoteImages ? '撤销远程图片权限' : '加载本邮件 HTTPS 图片'}</button>
      </div>
      <iframe
        class="h-[62vh] min-h-[28rem] w-full rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-white"
        src={htmlUrl}
        title="安全 HTML 邮件正文"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
        loading="lazy"
      ></iframe>
    {:else if body}
      {#if hasHtml}
        <div class="mb-4 flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] px-3 py-2 text-xs text-[var(--fm-text-secondary)]" role="note">
          <FileWarning class="mt-0.5 size-4 shrink-0 text-[var(--fm-warning)]" aria-hidden="true" />
          <span>纯文本是默认安全视图；切换到 HTML 时只会显示服务端严格净化后的隔离文档。</span>
        </div>
      {/if}
      <div class="max-w-[76ch] whitespace-pre-wrap break-words text-[15px] leading-[1.75] text-[var(--fm-text)]">{body}</div>
    {:else}
      <p class="py-8 text-sm text-[var(--fm-text-muted)]">{emptyLabel}</p>
    {/if}
  {:else}
    <p class="py-8 text-sm text-[var(--fm-text-muted)]">{emptyLabel}</p>
  {/if}
</section>
