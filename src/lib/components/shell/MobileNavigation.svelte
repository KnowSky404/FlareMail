<script lang="ts">
  import FileText from '@lucide/svelte/icons/file-text';
  import Archive from '@lucide/svelte/icons/archive';
  import Inbox from '@lucide/svelte/icons/inbox';
  import Menu from '@lucide/svelte/icons/menu';
  import PenLine from '@lucide/svelte/icons/pen-line';
  import Send from '@lucide/svelte/icons/send';
  import Settings from '@lucide/svelte/icons/settings';
  import { Drawer } from '$lib/components/ui';
  import type { MailboxSection } from '$lib/domain/mail';
  import BrandMark from './BrandMark.svelte';

  type AppSection = MailboxSection | 'profile';

  let {
    activeSection,
    unreadCount,
    draftCount,
    pending = false,
    onCompose,
    onSelectSection
  }: {
    activeSection: AppSection;
    unreadCount: number;
    draftCount: number;
    pending?: boolean;
    onCompose: () => void;
    onSelectSection: (section: AppSection) => void;
  } = $props();

  let open = $state(false);

  const labels: Record<AppSection, string> = {
    inbox: '收件箱',
    sent: '已发送',
    drafts: '草稿箱',
    archive: '归档',
    profile: '设置'
  };

  function select(section: AppSection) {
    onSelectSection(section);
    open = false;
  }
</script>

<header class="mobile-bar">
  <button class="icon" type="button" aria-label="打开导航" aria-expanded={open} onclick={() => (open = true)}>
    <Menu size={21} aria-hidden="true" />
  </button>
  <BrandMark compact />
  <strong>{labels[activeSection]}</strong>
  <button class="compose" type="button" aria-label="写邮件" title="写邮件" disabled={pending} onclick={onCompose}>
    <PenLine size={18} aria-hidden="true" /><span>写邮件</span>
  </button>
</header>

<Drawer {open} title="FlareMail 导航" description="切换邮箱文件夹与设置" side="left" width="sm" class="!max-w-80" onClose={() => (open = false)}>
    <nav class="mobile-nav-list" aria-label="移动端导航">
      <button class:active={activeSection === 'inbox'} type="button" onclick={() => select('inbox')}>
        <Inbox size={19} aria-hidden="true" /><span>收件箱</span><small>{unreadCount || ''}</small>
      </button>
      <button class:active={activeSection === 'sent'} type="button" onclick={() => select('sent')}>
        <Send size={19} aria-hidden="true" /><span>已发送</span>
      </button>
      <button class:active={activeSection === 'drafts'} type="button" onclick={() => select('drafts')}>
        <FileText size={19} aria-hidden="true" /><span>草稿箱</span><small>{draftCount || ''}</small>
      </button>
      <button class:active={activeSection === 'archive'} type="button" onclick={() => select('archive')}>
        <Archive size={19} aria-hidden="true" /><span>归档</span>
      </button>
      <button class:active={activeSection === 'profile'} type="button" onclick={() => select('profile')}>
        <Settings size={19} aria-hidden="true" /><span>设置</span>
      </button>
    </nav>
</Drawer>

<style>
  .mobile-bar {
    position: relative;
    z-index: 40;
    display: none;
    height: 52px;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-2);
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

  @media (max-width: 767px) {
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
