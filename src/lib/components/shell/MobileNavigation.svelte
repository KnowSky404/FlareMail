<script lang="ts">
  import FileText from '@lucide/svelte/icons/file-text';
  import Archive from '@lucide/svelte/icons/archive';
  import Inbox from '@lucide/svelte/icons/inbox';
  import Menu from '@lucide/svelte/icons/menu';
  import PenLine from '@lucide/svelte/icons/pen-line';
  import Send from '@lucide/svelte/icons/send';
  import Settings from '@lucide/svelte/icons/settings';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { Drawer } from '$lib/components/ui';
  import type { MailboxSection } from '$lib/domain/mail';
  import { formatNumber } from '$lib/i18n';
  import BrandMark from './BrandMark.svelte';
  import LanguageSwitcher from './LanguageSwitcher.svelte';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  type AppSection = MailboxSection | 'trash' | 'profile';

  let {
    activeSection,
    inboxCount,
    draftCount,
    trashCount,
    pending = false,
    onCompose,
    onSelectSection
  }: {
    activeSection: AppSection;
    inboxCount: number;
    draftCount: number;
    trashCount: number;
    pending?: boolean;
    onCompose: () => void;
    onSelectSection: (section: AppSection) => void;
  } = $props();

  let open = $state(false);
  const i18n = useLocale();
  const { t } = i18n;

  const labels = $derived<Record<AppSection, string>>({
    inbox: t('shell.inbox'),
    sent: t('shell.sent'),
    drafts: t('shell.drafts'),
    archive: t('shell.archive'),
    trash: t('shell.trash'),
    profile: t('common.settings')
  });

  const formattedInboxCount = $derived(inboxCount ? formatNumber(inboxCount, i18n.locale) : '');
  const formattedDraftCount = $derived(draftCount ? formatNumber(draftCount, i18n.locale) : '');
  const formattedTrashCount = $derived(trashCount ? formatNumber(trashCount, i18n.locale) : '');

  function select(section: AppSection) {
    onSelectSection(section);
    open = false;
  }
</script>

<header class="mobile-bar">
  <button class="icon" type="button" aria-label={t('shell.openNavigation')} aria-expanded={open} onclick={() => (open = true)}>
    <Menu size={21} aria-hidden="true" />
  </button>
  <BrandMark compact />
  <strong>{labels[activeSection]}</strong>
  <button class="compose" type="button" aria-label={t('shell.compose')} title={t('shell.compose')} disabled={pending} onclick={onCompose}>
    <PenLine size={18} aria-hidden="true" /><span>{t('shell.compose')}</span>
  </button>
</header>

<Drawer {open} title={t('shell.mobileNavigation')} description={t('shell.mobileNavigationDescription')} side="left" width="sm" class="!max-w-80" onClose={() => (open = false)}>
    <nav class="mobile-nav-list" aria-label={t('shell.mobileNavigation')}>
      <button class:active={activeSection === 'inbox'} type="button" onclick={() => select('inbox')}>
        <Inbox size={19} aria-hidden="true" /><span>{t('shell.inbox')}</span><small>{formattedInboxCount}</small>
      </button>
      <button class:active={activeSection === 'sent'} type="button" onclick={() => select('sent')}>
        <Send size={19} aria-hidden="true" /><span>{t('shell.sent')}</span>
      </button>
      <button class:active={activeSection === 'drafts'} type="button" onclick={() => select('drafts')}>
        <FileText size={19} aria-hidden="true" /><span>{t('shell.drafts')}</span><small>{formattedDraftCount}</small>
      </button>
      <button class:active={activeSection === 'archive'} type="button" onclick={() => select('archive')}>
        <Archive size={19} aria-hidden="true" /><span>{t('shell.archive')}</span>
      </button>
      <button class:active={activeSection === 'trash'} type="button" onclick={() => select('trash')}>
        <Trash2 size={19} aria-hidden="true" /><span>{t('shell.trash')}</span><small>{formattedTrashCount}</small>
      </button>
      <button class:active={activeSection === 'profile'} type="button" onclick={() => select('profile')}>
        <Settings size={19} aria-hidden="true" /><span>{t('common.settings')}</span>
      </button>
      <div class="mobile-language"><LanguageSwitcher /></div>
    </nav>
</Drawer>

<style>
  .mobile-bar {
    position: relative;
    z-index: 40;
    display: none;
    height: calc(52px + env(safe-area-inset-top));
    align-items: center;
    gap: var(--space-2);
    padding: env(safe-area-inset-top) var(--space-2) 0;
    border-bottom: 1px solid var(--fm-border);
    background: var(--fm-surface);
  }

  .mobile-bar strong {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    font-size: 15px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .icon,
  .compose {
    display: inline-flex;
    min-width: 44px;
    min-height: 44px;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: var(--radius-md);
    color: var(--fm-text-secondary);
    background: transparent;
  }

  .compose {
    gap: 6px;
    padding-inline: var(--space-3);
    color: var(--fm-primary);
    font-weight: 600;
  }

  .mobile-nav-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding-top: var(--space-3);
  }

  .mobile-nav-list button {
    display: grid;
    grid-template-columns: 22px 1fr auto;
    min-height: 48px;
    align-items: center;
    gap: var(--space-3);
    padding: 0 var(--space-3);
    border: 0;
    border-radius: var(--radius-md);
    color: var(--fm-text-secondary);
    background: transparent;
    text-align: left;
  }

  .mobile-nav-list button.active {
    color: var(--fm-primary);
    background: var(--fm-surface-selected);
    font-weight: 600;
  }

  .mobile-nav-list small {
    font-size: 11px;
  }

  .mobile-language {
    margin-top: var(--space-3);
    padding: var(--space-3) var(--space-3) 0;
    border-top: 1px solid var(--fm-border);
  }

  @media (max-width: 900px) {
    .mobile-bar {
      display: flex;
    }
  }

  @media (max-width: 420px) {
    .compose span {
      display: none;
    }

    .compose {
      padding: 0;
    }
  }
</style>
