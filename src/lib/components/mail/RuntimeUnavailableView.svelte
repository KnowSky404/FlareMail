<script lang="ts">
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import type { RuntimeUnavailableState } from '$lib/domain/runtime-state';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let { state }: { state: RuntimeUnavailableState } = $props();

  const { t } = useLocale();
  const labels = $derived<Record<RuntimeUnavailableState['code'], { title: string; description: string }>>({
    CONFIG_INVALID: { title: t('runtime.configTitle'), description: t('runtime.configDescription') },
    AUTHENTICATION_UNAVAILABLE: { title: t('runtime.authTitle'), description: t('runtime.authDescription') },
    SCHEMA_NOT_READY: { title: t('runtime.schemaTitle'), description: t('runtime.schemaDescription') },
    D1_UNAVAILABLE: { title: t('runtime.d1Title'), description: t('runtime.d1Description') },
    R2_UNAVAILABLE: { title: t('runtime.r2Title'), description: t('runtime.r2Description') },
    NETWORK_FAILURE: { title: t('runtime.networkTitle'), description: t('runtime.networkDescription') },
    INTERNAL_ERROR: { title: t('runtime.internalTitle'), description: t('runtime.internalDescription') }
  });
  const copy = $derived(labels[state.code]);
</script>

<main class="unavailable-shell">
  <section aria-labelledby="unavailable-title">
    <span class="icon" aria-hidden="true"><CircleAlert size={24} /></span>
    <div>
      <p class="eyebrow">{t('runtime.eyebrow')}</p>
      <h1 id="unavailable-title">{copy.title}</h1>
      <p class="description">{copy.description}</p>
      <p class="request-id">{t('runtime.requestId')}：<code>{state.requestId}</code></p>
      <div class="actions">
        <button type="button" onclick={() => location.reload()} disabled={!state.retryable}><RefreshCw size={16} aria-hidden="true" />{t('mail.retry')}</button>
        <a href="/api/readiness" target="_blank" rel="noreferrer">{t('runtime.openHealth')}</a>
      </div>
    </div>
  </section>
</main>

<style>
  .unavailable-shell { display: grid; min-height: 100dvh; place-items: center; padding: 24px; background: var(--fm-canvas); }
  section { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 16px; width: min(620px, 100%); padding: 24px; border: 1px solid var(--fm-border); border-radius: var(--radius-lg); background: var(--fm-surface); }
  .icon { display: grid; width: 44px; height: 44px; place-items: center; border-radius: var(--radius-md); color: var(--fm-danger); background: var(--fm-danger-soft); }
  .eyebrow { margin: 0 0 6px; color: var(--fm-text-muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  h1 { margin: 0; color: var(--fm-text); font-size: 20px; line-height: 1.3; }
  .description { margin: 10px 0 0; color: var(--fm-text-secondary); font-size: 14px; line-height: 1.6; }
  .request-id { margin: 12px 0 0; color: var(--fm-text-muted); font-size: 12px; overflow-wrap: anywhere; }
  code { color: var(--fm-text-secondary); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
  button, a { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; gap: 7px; padding: 0 14px; border: 1px solid var(--fm-border); border-radius: var(--radius-md); color: var(--fm-text); background: var(--fm-surface); font-size: 13px; font-weight: 600; text-decoration: none; }
  button:not(:disabled), a { cursor: pointer; }
  button:not(:disabled):hover, a:hover { background: var(--fm-surface-hover); }
  button:disabled { opacity: .55; }
  @media (max-width: 480px) { section { grid-template-columns: 1fr; padding: 18px; } }
</style>
