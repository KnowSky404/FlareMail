<script lang="ts">
  import FileText from '@lucide/svelte/icons/file-text';
  import Archive from '@lucide/svelte/icons/archive';
  import Inbox from '@lucide/svelte/icons/inbox';
  import PenLine from '@lucide/svelte/icons/pen-line';
  import Send from '@lucide/svelte/icons/send';
  import Settings from '@lucide/svelte/icons/settings';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import type { LucideIcon } from '@lucide/svelte';
  import type { MailboxSection } from '$lib/domain/mail';

  type AppSection = MailboxSection | 'trash' | 'profile';
  type NavigationItem = {
    id: AppSection;
    label: string;
    count: number;
    icon: LucideIcon;
  };

  let {
    activeSection,
    inboxCount,
    sentCount,
    draftCount,
    trashCount,
    pending = false,
    onCompose,
    onSelectSection
  }: {
    activeSection: AppSection;
    inboxCount: number;
    sentCount: number;
    draftCount: number;
    trashCount: number;
    pending?: boolean;
    onCompose: () => void;
    onSelectSection: (section: AppSection) => void;
  } = $props();

  const navigation = $derived<NavigationItem[]>([
    { id: 'inbox', label: '收件箱', count: inboxCount, icon: Inbox },
    { id: 'sent', label: '已发送', count: sentCount, icon: Send },
    { id: 'drafts', label: '草稿箱', count: draftCount, icon: FileText },
    { id: 'archive', label: '归档', count: 0, icon: Archive },
    { id: 'trash', label: '垃圾箱', count: trashCount, icon: Trash2 },
    { id: 'profile', label: '设置', count: 0, icon: Settings }
  ]);
</script>

<aside class="sidebar" aria-label="邮箱导航">
  <button class="compose" type="button" disabled={pending} onclick={onCompose}>
    <PenLine size={18} strokeWidth={2} aria-hidden="true" />
    <span>写邮件</span>
  </button>

  <nav aria-label="主导航">
    {#each navigation as item}
      {@const Icon = item.icon}
      <button
        type="button"
        class:active={activeSection === item.id}
        aria-current={activeSection === item.id ? 'page' : undefined}
        aria-label={item.label}
        title={item.label}
        onclick={() => onSelectSection(item.id)}
      >
        <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
        <span class="label">{item.label}</span>
        {#if item.count > 0}
          <span class="count" aria-label={`${item.count} 封`}>{item.count > 99 ? '99+' : item.count}</span>
        {/if}
      </button>
    {/each}
  </nav>

  <p class="powered">运行于 Cloudflare Workers</p>
</aside>

<style>
  .sidebar {
    display: flex;
    min-height: 0;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-3);
    border-right: 1px solid var(--fm-border);
    background: var(--fm-canvas);
  }

  .compose {
    display: flex;
    min-height: var(--control-prominent);
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: 0 var(--space-4);
    border: 1px solid var(--fm-primary);
    border-radius: var(--radius-md);
    color: var(--fm-text-inverse);
    background: var(--fm-primary);
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
    transition: background var(--motion-fast), border-color var(--motion-fast);
  }

  .compose:hover:not(:disabled) {
    border-color: var(--fm-primary-hover);
    background: var(--fm-primary-hover);
  }

  .compose:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  nav button {
    position: relative;
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr) auto;
    min-height: 40px;
    align-items: center;
    gap: var(--space-3);
    padding: 0 var(--space-3);
    border: 0;
    border-radius: var(--radius-md);
    color: var(--fm-text-secondary);
    background: transparent;
    cursor: pointer;
    font-size: 14px;
    text-align: left;
  }

  nav button:hover {
    color: var(--fm-text);
    background: var(--fm-surface-hover);
  }

  nav button.active {
    color: var(--fm-primary);
    background: var(--fm-surface-selected);
    font-weight: 600;
  }

  nav button.active::before {
    position: absolute;
    top: 8px;
    bottom: 8px;
    left: 0;
    width: 3px;
    border-radius: 0 2px 2px 0;
    background: var(--fm-brand-orange);
    content: '';
  }

  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    min-width: 22px;
    padding: 1px 6px;
    border-radius: var(--radius-pill);
    color: var(--fm-text-secondary);
    background: var(--fm-surface-subtle);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .active .count {
    color: var(--fm-primary);
    background: var(--fm-primary-soft);
  }

  .powered {
    margin: auto 0 0;
    padding: var(--space-3);
    color: var(--fm-text-muted);
    font-size: 11px;
    line-height: 1.5;
  }

  @media (max-width: 1279px) {
    .sidebar {
      align-items: center;
      padding-inline: var(--space-2);
    }

    .compose {
      width: 44px;
      height: 44px;
      padding: 0;
    }

    .compose span,
    .label,
    .powered {
      display: none;
    }

    nav {
      width: 100%;
    }

    nav button {
      display: flex;
      width: 100%;
      min-height: 44px;
      justify-content: center;
      padding: 0;
    }

    .count {
      position: absolute;
      top: 2px;
      right: 0;
      min-width: 17px;
      padding: 0 4px;
      border: 2px solid var(--fm-canvas);
      font-size: 9px;
      line-height: 14px;
    }
  }

  @media (max-width: 767px) {
    .sidebar {
      display: none;
    }
  }
</style>
