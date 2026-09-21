<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    busy = false,
    error = '',
    onOpenSignIn,
    onRetry
  }: {
    busy?: boolean;
    error?: string;
    onOpenSignIn: () => void;
    onRetry: () => void | Promise<unknown>;
  } = $props();

  const { t } = useLocale();
</script>

<section class="mx-3 mt-3 grid gap-3 rounded-[var(--radius-md)] border border-[var(--fm-warning)]/40 bg-[var(--fm-warning-soft)] px-4 py-3 text-sm text-[var(--fm-text)] sm:mx-5 sm:grid-cols-[1fr_auto] sm:items-center" role="alert" aria-live="assertive">
  <div class="min-w-0">
    <h2 class="font-semibold">{t('auth.sessionExpiredTitle')}</h2>
    <p class="mt-1 text-xs leading-5 text-[var(--fm-text-secondary)]">{t('auth.sessionExpiredDescription')}</p>
    {#if error}
      <p class="mt-2 text-xs text-[var(--fm-danger)]" role="status">{error}</p>
    {/if}
  </div>
  <div class="flex flex-wrap items-center gap-2">
    <Button variant="outline" size="sm" onclick={onOpenSignIn}>{t('auth.openSignInTab')}</Button>
    <Button variant="primary" size="sm" loading={busy} disabled={busy} onclick={onRetry}>
      {busy ? t('auth.retryingSession') : t('auth.retrySession')}
    </Button>
  </div>
</section>
