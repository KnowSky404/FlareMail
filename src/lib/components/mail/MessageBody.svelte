<script lang="ts">
  import { LoaderCircle } from '@lucide/svelte';
  import type { MessageBodyView } from '$lib/domain/mail';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    body = '', loading = false, hasHtml = false, emptyLabel, messageId = '', view = 'text'
  }: {
    body?: string;
    loading?: boolean;
    hasHtml?: boolean;
    emptyLabel?: string;
    messageId?: string;
    view?: MessageBodyView;
  } = $props();
  const { t } = useLocale();
  const htmlUrl = $derived(messageId ? `/api/workspace/messages/${encodeURIComponent(messageId)}/html?mode=${view === 'unsafe' ? 'unsafe' : 'safe'}` : '');
</script>

<section aria-label={t('mail.bodyTitle')} class="message-body min-w-0">
  {#if loading}
    <div class="flex items-center gap-2 py-8 text-sm text-[var(--fm-text-muted)]" role="status" aria-live="polite">
      <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />{t('mail.loading')}
    </div>
  {:else if hasHtml && view !== 'text' && htmlUrl}
    <iframe
      class="message-html-frame w-full border-0 bg-white"
      src={htmlUrl}
      title={view === 'unsafe' ? t('mail.unsafeHtmlTitle') : t('mail.safeHtmlTitle')}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerpolicy="no-referrer"
      loading="lazy"
    ></iframe>
  {:else if body}
    <div class="message-plain-body whitespace-pre-wrap break-words text-[15px] leading-[1.8] text-[var(--fm-text)]">{body}</div>
  {:else}
    <p class="py-8 text-sm text-[var(--fm-text-muted)]">{emptyLabel ?? t('mail.noBody')}</p>
  {/if}
</section>

<style>
  .message-html-frame { display: block; height: clamp(22rem, 72dvh, 64rem); }
  .message-plain-body { max-width: 86ch; overflow-wrap: anywhere; }
</style>
