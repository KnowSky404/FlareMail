<script lang="ts">
  import { ExternalLink, FileDown, Info, MoreHorizontal } from '@lucide/svelte';
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
  const modes = ['text', 'html', 'unsafe'] as const;
  const label = (mode: MessageBodyView) => mode === 'text' ? t('mail.plainText') : mode === 'html' ? t('mail.safeHtml') : t('mail.unsafeHtml');
  const hint = $derived(view === 'unsafe' ? t('mail.unsafeHtmlNote') : view === 'html' ? t('mail.remoteImageNote') : t('mail.plainTextSecurityNote'));
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
    {#each modes as mode}
      <button type="button" class:active={view === mode} class:unsafe-active={view === 'unsafe' && mode === 'unsafe'} aria-pressed={view === mode} onclick={() => onViewChange(mode)}>{label(mode)}</button>
    {/each}
  </div>
  <Tooltip content={hint} side="bottom" floating containEscape>
    {#snippet trigger(tooltipId)}
      <button type="button" class="view-info" aria-label={t('mail.viewHelp')} aria-describedby={tooltipId} onclick={(event) => event.currentTarget.focus()}><Info class="size-3.5" aria-hidden="true" /></button>
    {/snippet}
  </Tooltip>
  <DropdownMenu id={`display-actions-${runtimeId}`} open={displayActionsOpen} align="end" viewportAware showChevron={false} triggerAriaLabel={t('mail.displayOptions')} triggerTitle={t('mail.displayOptions')} class="message-display-actions" onOpenChange={(open) => (displayActionsOpen = open)}>
    {#snippet trigger()}<MoreHorizontal class="size-4" aria-hidden="true" />{/snippet}
    {#snippet children()}
      <a class="display-action" role="menuitem" href={`${htmlUrl}&print=1`} target="_blank" rel="noopener noreferrer"><ExternalLink class="size-4" aria-hidden="true" />{t('mail.printView')}</a>
      <button class="display-action" role="menuitem" type="button" onclick={downloadDisplayReport}><FileDown class="size-4" aria-hidden="true" />{t('mail.displayReport')}</button>
    {/snippet}
  </DropdownMenu>
</div>

<style>
  .view-segments { border: 1px solid var(--fm-border); border-radius: var(--radius-md); padding: 2px; background: var(--fm-surface-subtle); }
  .view-segments button { min-height: 28px; padding: 0 10px; border-radius: calc(var(--radius-md) - 2px); font-size: 11px; font-weight: 500; color: var(--fm-text-secondary); white-space: nowrap; transition: background 120ms, color 120ms; }
  .view-segments button:hover { color: var(--fm-text); background: var(--fm-surface-hover); }
  .view-segments button.active { color: var(--fm-primary); background: var(--fm-surface); box-shadow: 0 1px 3px rgb(0 0 0 / 8%); }
  .view-segments button.unsafe-active { color: var(--fm-warning); }
  .view-info, :global(.message-display-actions .fm-menu-trigger) { display: grid; place-items: center; width: 30px; height: 32px; border-radius: var(--radius-md); color: var(--fm-text-muted); }
  .view-info:hover, :global(.message-display-actions .fm-menu-trigger:hover) { background: var(--fm-surface-hover); color: var(--fm-text); }
  :global(.message-display-actions [role='menu']) { width: 15rem; }
  .display-action { display: flex; width: 100%; min-height: 36px; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--radius-md); font-size: 12px; text-align: left; color: var(--fm-text-secondary); }
  .display-action:hover { background: var(--fm-surface-hover); color: var(--fm-text); }
  @media (max-width: 900px) {
    .view-segments button { min-width: 44px; min-height: 44px; padding: 0 9px; }
    .view-info, :global(.message-display-actions .fm-menu-trigger) { width: 44px; height: 44px; }
    .display-action { min-height: 44px; }
  }
  @media (max-width: 359px) { .view-segments button { padding: 0 5px; font-size: 10px; } }
  @media (prefers-reduced-motion: reduce) { .view-segments button { transition: none; } }
</style>
