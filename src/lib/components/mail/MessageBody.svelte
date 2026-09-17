<script lang="ts">
  import { ExternalLink, FileDown, FileWarning, ImageOff, LoaderCircle, MoreHorizontal } from '@lucide/svelte';
  import { DropdownMenu } from '$lib/components/ui';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    body = '',
    loading = false,
    hasHtml = false,
    emptyLabel,
    messageId = '',
    view = 'text',
    allowRemoteImages = false,
    onViewChange,
    onRemoteImagesChange,
    onReportIssue
  }: {
    body?: string;
    loading?: boolean;
    hasHtml?: boolean;
    emptyLabel?: string;
    messageId?: string;
    view?: 'text' | 'html';
    allowRemoteImages?: boolean;
    onViewChange?: (view: 'text' | 'html') => void;
    onRemoteImagesChange?: (allowed: boolean) => void;
    onReportIssue?: () => void;
  } = $props();

  const { t } = useLocale();

  let localView = $state<'text' | 'html'>('text');
  let localRemoteImages = $state(false);
  let displayActionsOpen = $state(false);
  const activeView = $derived(onViewChange ? view : localView);
  const activeRemoteImages = $derived(onRemoteImagesChange ? allowRemoteImages : localRemoteImages);
  const changeView = (next: 'text' | 'html') => onViewChange ? onViewChange(next) : (localView = next);
  const changeRemoteImages = (next: boolean) => onRemoteImagesChange ? onRemoteImagesChange(next) : (localRemoteImages = next);

  const htmlUrl = $derived(messageId ? `/api/workspace/messages/${encodeURIComponent(messageId)}/html?remote=${activeRemoteImages ? '1' : '0'}` : '');
  const printUrl = $derived(htmlUrl ? `${htmlUrl}&print=1` : '');

  function downloadDisplayReport() {
    if (!messageId || typeof document === 'undefined') return;
    const report = {
      version: 1,
      messageId,
      generatedAt: new Date().toISOString(),
      view: activeView,
      remoteImagesAllowed: activeRemoteImages,
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
  <h2 id="message-body-title" class="sr-only">{t('mail.bodyTitle')}</h2>
  {#if loading}
    <div class="flex items-center gap-2 py-8 text-sm text-[var(--fm-text-muted)]" role="status" aria-live="polite">
      <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />{t('mail.loading')}
    </div>
  {:else if body || hasHtml}
    {#if hasHtml}
      <div class="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--fm-border)] pb-3">
        <div class="inline-flex rounded-[var(--radius-md)] border border-[var(--fm-border)] p-0.5" role="group" aria-label={t('mail.bodyTitle')}>
          <button class={`min-h-11 rounded-[calc(var(--radius-md)-2px)] px-3 text-xs font-medium sm:min-h-9 ${activeView === 'text' ? 'bg-[var(--fm-primary)] text-[var(--fm-text-inverse)]' : ''}`} type="button" aria-pressed={activeView === 'text'} onclick={() => changeView('text')}>{t('mail.plainText')}</button>
          <button class={`min-h-11 rounded-[calc(var(--radius-md)-2px)] px-3 text-xs font-medium sm:min-h-9 ${activeView === 'html' ? 'bg-[var(--fm-primary)] text-[var(--fm-text-inverse)]' : ''}`} type="button" aria-pressed={activeView === 'html'} onclick={() => changeView('html')}>{t('mail.safeHtml')}</button>
        </div>
        <DropdownMenu
          id="message-display-actions"
          open={displayActionsOpen}
          align="end"
          showChevron={false}
          triggerAriaLabel={t('mail.moreActions')}
          triggerTitle={t('mail.moreActions')}
          class="message-display-actions"
          onOpenChange={(open) => (displayActionsOpen = open)}
        >
          {#snippet trigger()}
            <MoreHorizontal class="size-4" aria-hidden="true" />
          {/snippet}
          {#snippet children()}
            {#if printUrl}
              <a class="menu-action fm-touch-target" role="menuitem" href={printUrl} target="_blank" rel="noopener noreferrer"><ExternalLink class="size-4" aria-hidden="true" />{t('mail.printView')}</a>
            {/if}
            <button class="menu-action fm-touch-target" role="menuitem" type="button" onclick={downloadDisplayReport}><FileDown class="size-4" aria-hidden="true" />{t('mail.displayReport')}</button>
          {/snippet}
        </DropdownMenu>
      </div>
    {/if}
    {#if hasHtml && activeView === 'html' && htmlUrl}
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] px-3 py-2 text-xs text-[var(--fm-text-secondary)]" role="note">
        <span class="flex min-w-0 items-start gap-2"><ImageOff class="mt-0.5 size-4 shrink-0 text-[var(--fm-warning)]" aria-hidden="true" /><span>{t('mail.remoteImageNote')}</span></span>
        <button class="min-h-11 shrink-0 rounded-[var(--radius-md)] border border-[var(--fm-border)] px-2.5 font-medium hover:bg-[var(--fm-surface-hover)] sm:min-h-9" type="button" aria-pressed={activeRemoteImages} onclick={() => changeRemoteImages(!activeRemoteImages)}>{activeRemoteImages ? t('mail.revokeRemoteImages') : t('mail.remoteImages')}</button>
      </div>
      <iframe
        class="message-html-frame min-h-[22rem] w-full rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-white"
        src={htmlUrl}
        title={t('mail.safeHtmlTitle')}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
        loading="lazy"
      ></iframe>
    {:else if body}
      {#if hasHtml}
        <div class="mb-4 flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] px-3 py-2 text-xs text-[var(--fm-text-secondary)]" role="note">
          <FileWarning class="mt-0.5 size-4 shrink-0 text-[var(--fm-warning)]" aria-hidden="true" />
          <span>{t('mail.plainTextSecurityNote')}</span>
        </div>
      {/if}
        <div class="message-plain-body whitespace-pre-wrap break-words text-[15px] leading-[1.75] text-[var(--fm-text)]">{body}</div>
    {:else}
      <p class="py-8 text-sm text-[var(--fm-text-muted)]">{emptyLabel ?? t('mail.noBody')}</p>
    {/if}
  {:else}
    <p class="py-8 text-sm text-[var(--fm-text-muted)]">{emptyLabel ?? t('mail.noBody')}</p>
  {/if}
</section>

<style>
  .message-html-frame {
    height: clamp(18rem, 68dvh, 56rem);
    min-height: 18rem;
  }

  .message-plain-body {
    width: min(100%, 78ch);
  }

  :global(.fm-reader-body) .message-plain-body {
    width: min(100%, 86ch);
  }

  :global(.message-display-actions > button) {
    width: var(--control-compact);
    height: var(--control-compact);
    padding: 0;
    color: var(--fm-text-secondary);
  }

  :global(.message-display-actions [role='menu']) {
    width: 15rem;
  }

  @media (max-width: 900px) {
    :global(.message-display-actions > button) {
      width: 44px;
      height: 44px;
    }
  }
</style>
