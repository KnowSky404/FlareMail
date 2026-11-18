<script lang="ts">
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import { ChevronRight, Info, LoaderCircle, RotateCw, Sparkles } from '@lucide/svelte';
  import { Button, ConfirmDialog, Tooltip } from '$lib/components/ui';
  import { createWorkspaceSync, type WorkspaceSyncController } from '$lib/client/workspace-sync';
  import { nextRadioIndex } from '$lib/components/ui/radio-navigation';
  import { ClientApiError, requestJson } from '$lib/client/api';
  import type { MailMessage, MailInboxCategory } from '$lib/domain/mail';
  import type { MailAiResponse } from '$lib/domain/mail/ai';
  import { useLocale } from '$lib/i18n/runtime.svelte';
  let { message, onApplyCategory }: { message: MailMessage; onApplyCategory?: (message: MailMessage, category: MailInboxCategory) => Promise<void> } = $props();
  const i18n = useLocale();
  const { t } = i18n;
  let open = $state(true);
  let toggleButton = $state<HTMLButtonElement>();
  const views = ['summary', 'category'] as const;
  type View = typeof views[number];
  type Generation = 'generate' | 'regenerate';
  let view = $state<View>('summary');
  let confirmation = $state<Generation | null>(null);
  let result = $state<MailAiResponse | null>(null);
  let busy = $state(false);
  let applying = $state(false);
  let error = $state('');
  let invalidCache = $state(false);
  let appliedCategory = $state<MailInboxCategory | null>(null);
  const applied = $derived(appliedCategory !== null && message.inboxCategoryOverride === appliedCategory);
  let sync: WorkspaceSyncController | undefined;
  onMount(() => { sync = createWorkspaceSync(() => undefined); });
  let controller = new AbortController();
  let requestSequence = 0;
  onDestroy(() => { requestSequence++; controller.abort(); sync?.close(); });
  const requestIdentity = $derived(`${message.id}:${i18n.locale}`);
  $effect(() => {
    requestIdentity;
    untrack(() => {
      requestSequence++; controller.abort();
      busy = false; result = null; error = ''; invalidCache = false; appliedCategory = null;
      open = true; view = 'summary'; confirmation = null; void load();
    });
  });
  const panelId = $props.id();
  const analysis = $derived(result?.analysis);
  const generation = $derived<Generation | null>(invalidCache || analysis
    ? 'regenerate' : result?.status === 'empty' ? 'generate' : null);
  const details = $derived([
    t('ai.privacy'),
    result?.updatedAt ? `${t('ai.generatedAt')} ${new Date(result.updatedAt).toLocaleString(i18n.locale)}.` : '',
    result?.truncated ? t('ai.truncated') : '',
    t('ai.caution')
  ].filter(Boolean).join(' '));

  function moveTab(event: KeyboardEvent, index: number) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') return;
    const next = nextRadioIndex(event.key, index, views.length);
    if (next === null) return;
    event.preventDefault();
    view = views[next];
    document.getElementById(`${panelId}-tab-${view}`)?.focus();
  }

  function focusToggle() {
    void tick().then(() => toggleButton?.focus({ preventScroll: true }));
  }

  function confirmGeneration() {
    if (!confirmation) return;
    const regenerate = confirmation === 'regenerate';
    confirmation = null;
    void load(true, regenerate);
    focusToggle();
  }

  const errorHints = {
    AI_PROVIDER_AUTH: 'ai.providerAuth', AI_PROVIDER_FORBIDDEN: 'ai.providerForbidden',
    AI_PROVIDER_MODEL_NOT_FOUND: 'ai.providerModel', AI_PROVIDER_NOT_FOUND: 'ai.providerEndpoint',
    AI_PROVIDER_BAD_REQUEST: 'ai.providerRequest', AI_PROVIDER_QUOTA: 'ai.providerQuota',
    AI_RATE_LIMITED: 'ai.providerRate', AI_PROVIDER_UNAVAILABLE: 'ai.providerUnavailable',
    AI_TIMEOUT: 'ai.providerTimeout', AI_OUTPUT_LIMIT: 'ai.outputLimit', AI_REFUSED: 'ai.refused'
  } as const;
  async function load(analyze = false, regenerate = false) {
    if (busy) return;
    busy = true; error = '';
    const sequence = ++requestSequence;
    controller = new AbortController();
    try {
      const response = await requestJson<MailAiResponse>(`/api/workspace/messages/${encodeURIComponent(message.id)}/ai${analyze ? '' : `?language=${i18n.locale}`}`, {
        signal: controller.signal, ...(analyze ? { method: 'POST', body: JSON.stringify({ language: i18n.locale, regenerate }) } : {})
      });
      if (sequence === requestSequence) {
        result = response;
        invalidCache = false;
        if (response.appliedCategory) sync?.publish({ type: 'mailbox-refresh', id: message.id });
      }
    } catch (cause) {
      if (sequence === requestSequence && !controller.signal.aborted) {
        const code = cause instanceof ClientApiError ? cause.code : 'NETWORK_FAILURE';
        if (code === 'AI_CACHE_INVALID') invalidCache = true;
        const hint = errorHints[code as keyof typeof errorHints];
        error = t('ai.error', { code }) + (hint ? ` ${t(hint)}` : '');
      }
    } finally { if (sequence === requestSequence) busy = false; }
  }
  function toggle() { open = !open; if (open && !result) void load(); }
  async function apply() {
    if (!analysis?.suggestion || !onApplyCategory || applying || message.inboxCategoryOverride) return;
    applying = true; error = '';
    try { const category = analysis.suggestion.category; await onApplyCategory(message, category); appliedCategory = category; }
    catch { error = t('ai.applyFailed'); }
    finally { applying = false; }
  }
</script>

<section class="ai-panel" aria-label={t('ai.title')}>
  <header class="ai-header">
    <button bind:this={toggleButton} type="button" class="ai-toggle" aria-expanded={open} aria-controls={panelId} onclick={toggle}>
      <span class="ai-mark"><Sparkles size={16} aria-hidden="true" /></span>
      <span>{t('ai.heading')}</span>
      <ChevronRight size={15} class={open ? 'ai-chevron-open' : undefined} aria-hidden="true" />
    </button>
    {#if open}
      <div class="ai-tools">
        <Tooltip content={details} side="bottom" floating hoverable containEscape>
          {#snippet trigger(tooltipId, showDetails)}
            <button type="button" class="ai-info" aria-label={t('ai.details')} aria-describedby={tooltipId} onclick={(event) => { event.currentTarget.focus(); showDetails(); }}>
              <Info size={16} aria-hidden="true" />
            </button>
          {/snippet}
        </Tooltip>
        {#if generation}
          <Button variant="ghost" size="sm" class="ai-generate" disabled={busy || applying || result?.refreshing} onclick={(event) => {
            (event.currentTarget as HTMLButtonElement).focus();
            confirmation = generation;
          }}>
            {#if generation === 'regenerate'}<RotateCw class="size-3.5 shrink-0" aria-hidden="true" />{/if}
            {t(`ai.${generation}`)}
          </Button>
        {/if}
      </div>
    {/if}
  </header>
  <div id={panelId} class="ai-content" hidden={!open}>
    {#if open}
      {#if error}<p role="alert" class="text-xs text-[var(--fm-danger)]">{error}</p>{/if}
      {#if busy}
        <p role="status" class="ai-status"><LoaderCircle class="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('ai.loading')}</p>
      {/if}
      {#if result?.status === 'disabled' || result?.status === 'unconfigured'}
        <p role="status" class="ai-status">{t(result.status === 'disabled' ? 'ai.disabled' : 'ai.unconfigured')}</p>
      {:else if !busy && (result?.status === 'processing' || result?.refreshing || error)}
        <div class="flex flex-wrap items-center gap-2">
          {#if result?.status === 'processing' || result?.refreshing}<p role="status" class="ai-status">{t('ai.processing')}</p>{/if}
          <Button variant="secondary" size="sm" disabled={applying} onclick={() => { void load(); focusToggle(); }}>{t('ai.refresh')}</Button>
        </div>
      {/if}
      {#if analysis}
        <div class="ai-tabs" role="tablist" aria-label={t('ai.views')}>
          {#each views as item, index (item)}
            <button type="button" role="tab" id={`${panelId}-tab-${item}`} aria-selected={view === item}
              aria-controls={`${panelId}-${item}`} tabindex={view === item ? 0 : -1}
              onkeydown={(event) => moveTab(event, index)} onclick={() => view = item}>{t(`ai.${item}`)}</button>
          {/each}
        </div>
        <div id={`${panelId}-summary`} role="tabpanel" aria-labelledby={`${panelId}-tab-summary`} tabindex="0" hidden={view !== 'summary'} class="ai-view">
          <p class="whitespace-pre-wrap">{analysis.summary}</p>
          {#each [{ title: 'ai.points' as const, items: analysis.keyPoints }, { title: 'ai.actions' as const, items: analysis.actionItems }, { title: 'ai.dates' as const, items: analysis.dates }] as group}
            {#if group.items.length}
              <div>
                <h2 class="mb-1 text-xs font-semibold">{t(group.title)}</h2>
                <ul class="list-disc space-y-1 pl-5">{#each group.items as item}<li>{item}</li>{/each}</ul>
              </div>
            {/if}
          {/each}
        </div>
        <div id={`${panelId}-category`} role="tabpanel" aria-labelledby={`${panelId}-tab-category`} tabindex="0" hidden={view !== 'category'} class="ai-view">
          <p class="text-xs text-[var(--fm-text-muted)]">{t('ai.currentCategory', { category: t(`mail.category.${message.inboxCategoryOverride ?? result?.appliedCategory ?? message.inboxCategory ?? 'primary'}`) })}</p>
          {#if analysis.suggestion}
            <div>
              <p class="font-semibold">{t(`mail.category.${analysis.suggestion.category}`)}</p>
              <p>{analysis.suggestion.reason}</p>
            </div>
            <p class="text-xs text-[var(--fm-text-muted)]">{t('ai.confidence', { confidence: Math.round(analysis.suggestion.confidence * 100) })}</p>
            {#if message.inboxCategoryOverride || applied}<p role="status">{t(applied ? 'ai.applied' : 'ai.manual')}</p>
            {:else if onApplyCategory && !message.archivedAt}<Button size="sm" loading={applying} disabled={busy} onclick={() => void apply()}>{t('ai.apply')}</Button>
            {:else}<p class="text-xs">{t('ai.inboxOnly')}</p>{/if}
          {:else}<p>{t('ai.noSuggestion')}</p>{/if}
        </div>
      {:else if result?.status === 'empty' && !busy}
        <p class="ai-status">{t('ai.empty')}</p>
      {/if}
    {/if}
  </div>
</section>

<ConfirmDialog open={confirmation !== null} title={t('ai.details')} description={t('ai.privacy')}
  confirmLabel={confirmation ? t(`ai.${confirmation}`) : undefined} variant="primary"
  onCancel={() => confirmation = null} onConfirm={confirmGeneration} />

<style>
  .ai-panel {
    min-width: 0;
    margin-bottom: var(--space-5);
    border: 1px solid var(--fm-border);
    border-radius: var(--radius-lg);
    background: var(--fm-surface-subtle);
  }

  .ai-header, .ai-toggle, .ai-tools, .ai-status {
    display: flex;
    align-items: center;
  }

  .ai-header {
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
  }

  .ai-toggle {
    min-height: 36px;
    gap: var(--space-2);
    border-radius: var(--radius-sm);
    color: var(--fm-text);
    font-size: 0.875rem;
    font-weight: 650;
    text-align: start;
  }

  .ai-toggle :global(svg) { flex-shrink: 0; }
  .ai-toggle > :global(svg) { color: var(--fm-text-muted); transition: transform 150ms; }
  .ai-toggle > :global(.ai-chevron-open) { transform: rotate(90deg); }

  .ai-mark, .ai-info {
    display: grid;
    flex-shrink: 0;
    place-items: center;
    border-radius: var(--radius-md);
  }

  .ai-mark {
    width: 2rem;
    height: 2rem;
    color: var(--fm-primary);
    background: var(--fm-primary-soft);
  }

  .ai-tools { gap: 2px; margin-inline-start: auto; }
  .ai-info { width: 2rem; height: 2rem; color: var(--fm-text-muted); }
  .ai-info:hover { color: var(--fm-text); background: var(--fm-surface-hover); }
  :global(.ai-panel .ai-generate) { color: var(--fm-primary); padding-inline: var(--space-2); text-wrap: pretty; }

  .ai-content {
    padding: 0 var(--space-3) var(--space-3);
    font-size: 0.875rem;
    line-height: 1.55;
    overflow-wrap: anywhere;
  }

  .ai-status { gap: var(--space-2); color: var(--fm-text-muted); font-size: 0.8125rem; }

  .ai-tabs {
    display: flex;
    gap: var(--space-3);
    border-bottom: 1px solid var(--fm-border);
  }

  .ai-tabs button {
    min-height: 36px;
    padding: 0 var(--space-1);
    margin-bottom: -1px;
    border-bottom: 2px solid transparent;
    color: var(--fm-text-secondary);
    font-weight: 550;
    text-align: start;
    transition: color 150ms, border-color 150ms;
  }

  .ai-tabs button:hover, .ai-tabs button[aria-selected='true'] { color: var(--fm-primary); }
  .ai-tabs button[aria-selected='true'] { border-bottom-color: currentColor; }
  .ai-view { padding-top: var(--space-3); }
  .ai-view > :global(* + *) { margin-top: var(--space-2); }

  @media (max-width: 900px) {
    .ai-toggle, .ai-info, .ai-tabs button, :global(.ai-panel .ai-generate) { min-height: 44px; }
    .ai-info { width: 44px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ai-toggle > :global(svg), .ai-tabs button { transition: none; }
  }
</style>
