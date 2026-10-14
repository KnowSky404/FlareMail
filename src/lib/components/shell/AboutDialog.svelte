<script lang="ts">
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import { focusRing } from '$lib/components/ui/styles';
  import { useLocale } from '$lib/i18n/runtime.svelte';
  import BrandMark from './BrandMark.svelte';

  let {
    open = false,
    version,
    restoreFocusElement,
    onClose
  }: {
    open?: boolean;
    version: string;
    restoreFocusElement?: HTMLElement | null;
    onClose: () => void;
  } = $props();

  const { t } = useLocale();
  const repositoryUrl = 'https://github.com/KnowSky404/FlareMail';

  function visibleAccountTrigger() {
    return [...document.querySelectorAll<HTMLElement>('button[aria-controls$="account-menu-content"]')]
      .find((element) => element.getClientRects().length > 0);
  }
</script>

<Dialog id="about-dialog" {open} title={t('about.title')} size="sm" {restoreFocusElement} fallbackFocus={visibleAccountTrigger} {onClose}>
  <div class="grid justify-items-center gap-5 py-2 text-center">
    <BrandMark />
    <dl class="grid w-full min-w-0 gap-4">
      <div>
        <dt class="text-xs text-[var(--fm-text-muted)]">{t('about.version')}</dt>
        <dd class="mt-1 text-base font-semibold text-[var(--fm-text)]">v{version}</dd>
      </div>
      <div class="min-w-0">
        <dt class="text-xs text-[var(--fm-text-muted)]">{t('about.repository')}</dt>
        <dd class="mt-1">
          <a href={repositoryUrl} target="_blank" rel="noopener noreferrer" class={`inline-flex max-w-full items-start gap-1 rounded text-sm text-[var(--fm-primary)] underline underline-offset-4 ${focusRing}`}>
            <span class="min-w-0 [overflow-wrap:anywhere]">{repositoryUrl}</span>
            <ExternalLink class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          </a>
        </dd>
      </div>
    </dl>
    <p class="text-xs text-[var(--fm-text-muted)]">© KnowSky404</p>
  </div>
</Dialog>
