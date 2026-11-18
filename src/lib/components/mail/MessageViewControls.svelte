<script lang="ts">
  import { ExternalLink, FileDown, Image, ImageOff, Info, MoreHorizontal } from '@lucide/svelte';
  import { DropdownMenu, Tooltip } from '$lib/components/ui';
  import type { MessageBodyView } from '$lib/domain/mail';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let { messageId, view, onViewChange, onReportIssue }: {
    messageId: string;
    view: MessageBodyView;
    onViewChange: (view: MessageBodyView) => void;
    onReportIssue?: () => void;
  } = $props();
  const { t } = useLocale();
  const runtimeId = $props.id();
  let displayActionsOpen = $state(false);
  const hint = $derived(view === 'unsafe' ? t('mail.unsafeHtmlNote') : view === 'html' ? t('mail.remoteImageNote') : t('mail.plainTextSecurityNote'));
  const imageAction = $derived(t(view === 'unsafe' ? 'mail.blockRemoteImages' : 'mail.remoteImages'));
  const htmlUrl = $derived(`/api/workspace/messages/${encodeURIComponent(messageId)}/html?mode=${view === 'unsafe' ? 'unsafe' : 'safe'}`);

  function downloadDisplayReport() {
    const report = {
      version: 1, messageId, generatedAt: new Date().toISOString(), view,
      remoteImagesAllowed: view === 'unsafe',
      viewport: { width: window.innerWidth, height: window.innerHeight }, userAgent: navigator.userAgent
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `flaremail-html-display-${messageId.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 80)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    displayActionsOpen = false;
    onReportIssue?.();
  }
</script>

<div class="message-view-controls flex min-w-0 items-center gap-0.5">
  <div class="view-segments inline-flex items-center" role="group" aria-label={t('mail.bodyTitle')}>
    <button type="button" aria-pressed={view === 'text'} onclick={() => onViewChange('text')}>{t('mail.plainText')}</button>
    <button type="button" class:remote-active={view === 'unsafe'} aria-pressed={view !== 'text'}
      onclick={() => { if (view !== 'unsafe') onViewChange('html'); }}>
      {view === 'unsafe' ? t('mail.remoteImagesOn') : t('mail.safeHtml')}
    </button>
  </div>
  <Tooltip content={hint} side="bottom" floating containEscape>
    {#snippet trigger(tooltipId, showDetails)}
      <button type="button" class="view-info" aria-label={t('mail.viewHelp')} aria-describedby={tooltipId} onclick={(event) => { event.currentTarget.focus(); showDetails(); }}><Info class="size-3.5" aria-hidden="true" /></button>
    {/snippet}
  </Tooltip>
  <DropdownMenu id={`display-actions-${runtimeId}`} open={displayActionsOpen} align="end" viewportAware showChevron={false} triggerAriaLabel={t('mail.displayOptions')} triggerTitle={t('mail.displayOptions')} class="message-display-actions" onOpenChange={(open) => (displayActionsOpen = open)}>
    {#snippet trigger()}<MoreHorizontal class="size-4" aria-hidden="true" />{/snippet}
    {#snippet children()}
      <button class="display-action" role="menuitem" type="button" aria-label={imageAction}
        aria-describedby={view !== 'unsafe' ? `remote-images-${runtimeId}` : undefined}
        onclick={() => onViewChange(view === 'unsafe' ? 'html' : 'unsafe')}>
        {#if view === 'unsafe'}<ImageOff class="size-4 shrink-0" aria-hidden="true" />{:else}<Image class="size-4 shrink-0" aria-hidden="true" />{/if}
        <span>
          {imageAction}
          {#if view !== 'unsafe'}<span class="display-note" id={`remote-images-${runtimeId}`}>{t('mail.remoteImagesRisk')}</span>{/if}
        </span>
      </button>
      <a class="display-action" role="menuitem" href={`${htmlUrl}&print=1`} target="_blank" rel="noopener noreferrer"><ExternalLink class="size-4" aria-hidden="true" />{t('mail.printView')}</a>
      <button class="display-action" role="menuitem" type="button" onclick={downloadDisplayReport}><FileDown class="size-4" aria-hidden="true" />{t('mail.displayReport')}</button>
    {/snippet}
  </DropdownMenu>
</div>

<style>
  .view-segments { gap: 2px; padding: 2px; border: 1px solid var(--fm-border); border-radius: var(--radius-md); background: var(--fm-surface-subtle); }
  .view-segments button { min-height: 28px; padding: 0 10px; border-radius: calc(var(--radius-md) - 2px); font-size: 12px; font-weight: 550; color: var(--fm-text-secondary); white-space: nowrap; transition: background 120ms, color 120ms; }
  .view-segments button:hover { color: var(--fm-text); background: var(--fm-surface-hover); }
  .view-segments button[aria-pressed='true'] { color: var(--fm-primary); background: var(--fm-primary-soft); }
  .view-segments button.remote-active[aria-pressed] { color: var(--fm-warning); }
  .view-info, :global(.message-display-actions .fm-menu-trigger) { display: grid; place-items: center; width: 30px; height: 32px; border-radius: var(--radius-md); color: var(--fm-text-muted); }
  .view-info:hover, :global(.message-display-actions .fm-menu-trigger:hover) { background: var(--fm-surface-hover); color: var(--fm-text); }
  :global(.message-display-actions [role='menu']) { width: 16rem; }
  .display-action { display: flex; width: 100%; min-height: 36px; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--radius-md); font-size: 12px; text-align: left; color: var(--fm-text-secondary); }
  .display-note { display: block; margin-top: 2px; color: var(--fm-text-muted); font-size: 11px; line-height: 1.4; }
  .display-action:hover { background: var(--fm-surface-hover); color: var(--fm-text); }
  @media (max-width: 900px) {
    .view-segments button { min-width: 44px; min-height: 44px; padding: 0 9px; }
    .view-info, :global(.message-display-actions .fm-menu-trigger) { width: 44px; height: 44px; }
    .display-action { min-height: 44px; }
  }
  @media (prefers-reduced-motion: reduce) { .view-segments button { transition: none; } }
</style>
