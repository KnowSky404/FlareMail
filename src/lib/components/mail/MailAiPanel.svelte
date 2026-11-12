<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { Sparkles } from '@lucide/svelte';
  import { Button, IconButton } from '$lib/components/ui';
  import { ClientApiError, requestJson } from '$lib/client/api';
  import type { MailMessage, MailInboxCategory } from '$lib/domain/mail';
  import type { MailAiResponse } from '$lib/domain/mail/ai';
  import { useLocale } from '$lib/i18n/runtime.svelte';
  let { message, onApplyCategory }: { message: MailMessage; onApplyCategory?: (message: MailMessage, category: MailInboxCategory) => Promise<void> } = $props();
  const i18n = useLocale();
  const { t } = i18n;
  let open = $state(false);
  let view = $state<'summary' | 'category'>('summary');
  let result = $state<MailAiResponse | null>(null);
  let busy = $state(false);
  let applying = $state(false);
  let error = $state('');
  let appliedCategory = $state<MailInboxCategory | null>(null);
  const applied = $derived(appliedCategory !== null && message.inboxCategoryOverride === appliedCategory);
  let controller = new AbortController();
  let requestSequence = 0;
  onDestroy(() => { requestSequence++; controller.abort(); });
  $effect(() => {
    message.id; i18n.locale;
    untrack(() => {
      requestSequence++; controller.abort();
      busy = false; result = null; error = ''; appliedCategory = null;
      if (open) void load();
    });
  });
  const panelId = $derived(`mail-ai-${message.id}`);
  const analysis = $derived(result?.analysis);
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
      if (sequence === requestSequence) result = response;
    } catch (cause) {
      if (sequence === requestSequence && !controller.signal.aborted) {
        const code = cause instanceof ClientApiError ? cause.code : 'NETWORK_FAILURE';
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

<section class="mb-4 min-w-0 border-b border-[var(--fm-border)] pb-3" aria-label={t('ai.title')}>
  <div class="flex items-center gap-1">
    <IconButton ariaLabel={t('ai.title')} title={t('ai.title')} tooltipSide="right" ariaExpanded={open} ariaControls={panelId} onclick={toggle} size="sm"><Sparkles class="size-4" aria-hidden="true" /></IconButton>
    <button type="button" class="rounded text-sm font-medium text-[var(--fm-text)] focus-visible:outline-2 focus-visible:outline-offset-4" aria-expanded={open} aria-controls={panelId} onclick={toggle}>{t('ai.title')}</button>
  </div>
  {#if open}
    <div id={panelId} class="mt-2 min-w-0 space-y-3 text-sm [overflow-wrap:anywhere]" aria-busy={busy || applying}>
      <p class="text-xs text-[var(--fm-text-muted)]">{t('ai.privacy')}</p>
      {#if error}<p role="alert" class="text-xs text-[var(--fm-danger)]">{error}</p>{/if}
      {#if busy}<p role="status">{t('ai.loading')}</p>{/if}
      {#if result?.status === 'disabled' || result?.status === 'unconfigured'}
        <p role="status">{t(result.status === 'disabled' ? 'ai.disabled' : 'ai.unconfigured')}</p>
      {:else if result?.status === 'processing'}
        <p role="status">{t('ai.processing')}</p>
        <Button variant="secondary" size="sm" disabled={busy} onclick={() => void load()}>{t('ai.refresh')}</Button>
      {:else if analysis}
        <div class="flex flex-wrap gap-2" role="group" aria-label={t('ai.views')}>
          <button type="button" class="rounded border border-[var(--fm-border)] px-3 py-1 focus-visible:outline-2" aria-pressed={view === 'summary'} onclick={() => view = 'summary'}>{t('ai.summary')}</button>
          <button type="button" class="rounded border border-[var(--fm-border)] px-3 py-1 focus-visible:outline-2" aria-pressed={view === 'category'} onclick={() => view = 'category'}>{t('ai.category')}</button>
        </div>
        {#if view === 'summary'}
          <p class="whitespace-pre-wrap">{analysis.summary}</p>
          {#each [{ title: 'ai.points' as const, items: analysis.keyPoints }, { title: 'ai.actions' as const, items: analysis.actionItems }, { title: 'ai.dates' as const, items: analysis.dates }] as group}
            {#if group.items.length}<div><h2 class="mb-1 text-xs font-semibold">{t(group.title)}</h2><ul class="list-disc space-y-1 pl-5">{#each group.items as item}<li>{item}</li>{/each}</ul></div>{/if}
          {/each}
        {:else}
          <p class="text-xs">{t('ai.currentCategory', { category: t(`mail.category.${message.inboxCategory ?? 'primary'}`) })}</p>
          {#if analysis.suggestion}
            <p class="font-medium">{t(`mail.category.${analysis.suggestion.category}`)}</p><p>{analysis.suggestion.reason}</p>
            <p class="text-xs text-[var(--fm-text-muted)]">{t('ai.confidence', { confidence: Math.round(analysis.suggestion.confidence * 100) })}</p>
            {#if message.inboxCategoryOverride || applied}<p role="status">{t(applied ? 'ai.applied' : 'ai.manual')}</p>
            {:else if onApplyCategory && !message.archivedAt}<Button size="sm" loading={applying} disabled={busy} onclick={() => void apply()}>{t('ai.apply')}</Button>
            {:else}<p class="text-xs">{t('ai.inboxOnly')}</p>{/if}
          {:else}<p>{t('ai.noSuggestion')}</p>{/if}
        {/if}
        {#if result?.truncated}<p class="text-xs text-[var(--fm-text-muted)]">{t('ai.truncated')}</p>{/if}
        <p class="text-xs text-[var(--fm-text-muted)]">{t('ai.caution')}</p>
        <Button variant="secondary" size="sm" disabled={busy || applying} onclick={() => void load(true, true)}>{t('ai.regenerate')}</Button>
      {:else if result?.status === 'empty'}
        <p>{t('ai.empty')}</p><Button variant="secondary" size="sm" disabled={busy} onclick={() => void load(true)}>{t('ai.generate')}</Button>
      {/if}
      {#if error}
        <div class="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" disabled={busy || applying} onclick={() => void load()}>{t('ai.refresh')}</Button>
          {#if !analysis}<Button variant="secondary" size="sm" disabled={busy || applying} onclick={() => void load(true, true)}>{t('ai.regenerate')}</Button>{/if}
        </div>
      {/if}
    </div>
  {/if}
</section>
