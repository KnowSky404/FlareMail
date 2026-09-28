<script lang="ts">
  import FileText from '@lucide/svelte/icons/file-text';
  import Archive from '@lucide/svelte/icons/archive';
  import Inbox from '@lucide/svelte/icons/inbox';
  import Star from '@lucide/svelte/icons/star';
  import PenLine from '@lucide/svelte/icons/pen-line';
  import Send from '@lucide/svelte/icons/send';
  import Settings from '@lucide/svelte/icons/settings';
  import Globe2 from '@lucide/svelte/icons/globe-2';
  import AtSign from '@lucide/svelte/icons/at-sign';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Tag from '@lucide/svelte/icons/tag';
  import Plus from '@lucide/svelte/icons/plus';
  import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
  import PanelLeftOpen from '@lucide/svelte/icons/panel-left-open';
  import type { LucideIcon } from '@lucide/svelte';
  import type { MailboxSection, MailUserLabel } from '$lib/domain/mail';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { formatNumber, translateCount } from '$lib/i18n';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  type AppSection = MailboxSection | 'trash' | 'profile';
  type NavigationId = AppSection | 'domains' | 'addresses';
  type NavigationItem = {
    id: NavigationId;
    label: string;
    count: number;
    icon: LucideIcon;
  };

  let {
    activeSection,
    inboxCount,
    starredCount,
    sentCount,
    draftCount,
    trashCount,
    managementView = 'settings',
    collapsed = false,
    pending = false,
    labels = [],
    activeLabelId = null,
    onCompose,
    onSelectLabel,
    onCreateLabel,
    onSelectSection,
    onSelectManagementView,
    onToggleCollapsed
  }: {
    activeSection: AppSection;
    inboxCount: number;
    starredCount: number;
    sentCount: number;
    draftCount: number;
    trashCount: number;
    managementView?: 'settings' | 'domains' | 'addresses';
    collapsed?: boolean;
    pending?: boolean;
    labels?: MailUserLabel[];
    activeLabelId?: string | null;
    onCompose: () => void;
    onSelectLabel?: (id: string) => void;
    onCreateLabel?: () => void;
    onSelectSection: (section: AppSection) => void;
    onSelectManagementView?: (view: 'domains' | 'addresses') => void;
    onToggleCollapsed?: () => void;
  } = $props();

  const i18n = useLocale();
  const { t } = i18n;

  const navigation = $derived<NavigationItem[]>([
    { id: 'inbox', label: t('shell.inbox'), count: inboxCount, icon: Inbox },
    { id: 'starred', label: t('shell.starred'), count: starredCount, icon: Star },
    { id: 'drafts', label: t('shell.drafts'), count: draftCount, icon: FileText },
    { id: 'sent', label: t('shell.sent'), count: sentCount, icon: Send },
    { id: 'archive', label: t('shell.archive'), count: 0, icon: Archive },
    { id: 'trash', label: t('shell.trash'), count: trashCount, icon: Trash2 },
    { id: 'domains', label: t('shell.domains'), count: 0, icon: Globe2 },
    { id: 'addresses', label: t('shell.addresses'), count: 0, icon: AtSign },
    { id: 'profile', label: t('common.settings'), count: 0, icon: Settings }
  ]);

  function isActive(id: NavigationId) {
    return id === 'domains' || id === 'addresses'
      ? activeSection === 'profile' && managementView === id
      : activeSection === id && (id !== 'profile' || managementView === 'settings');
  }
</script>

<aside id="fm-main-sidebar" class:collapsed class="sidebar" aria-label={t('shell.mailNavigation')}>
  <div class="sidebar-toolbar">
    <Tooltip content={collapsed ? t('shell.expand') : t('shell.collapse')} side="right" floating>
      {#snippet trigger(tooltipId)}
        <button class="collapse-toggle fm-touch-target" type="button" aria-expanded={!collapsed} aria-controls="fm-main-sidebar" aria-label={collapsed ? t('shell.expand') : t('shell.collapse')} aria-describedby={tooltipId} onclick={() => onToggleCollapsed?.()}>
          {#if collapsed}<PanelLeftOpen size={18} aria-hidden="true" />{:else}<PanelLeftClose size={18} aria-hidden="true" />{/if}
        </button>
      {/snippet}
    </Tooltip>
  </div>
  <Tooltip content={t('shell.compose')} side="right" floating disabled={!collapsed} class="w-full">
    {#snippet trigger(tooltipId)}
      <button class="compose" type="button" aria-label={t('shell.compose')} aria-describedby={collapsed ? tooltipId : undefined} disabled={pending} onclick={onCompose}>
        <PenLine size={18} strokeWidth={2} aria-hidden="true" />
        <span>{t('shell.compose')}</span>
      </button>
    {/snippet}
  </Tooltip>

  <nav aria-label={t('shell.mainNavigation')}>
    {#each navigation as item}
      {@const Icon = item.icon}
      <Tooltip content={item.label} side="right" floating disabled={!collapsed} class="w-full">
        {#snippet trigger(tooltipId)}
          <button
            type="button"
            class:active={isActive(item.id)}
            aria-current={isActive(item.id) ? 'page' : undefined}
            aria-label={item.label}
            aria-describedby={collapsed ? tooltipId : undefined}
            class="fm-touch-target"
            onclick={() => item.id === 'domains' || item.id === 'addresses' ? onSelectManagementView?.(item.id) : onSelectSection(item.id)}
          >
            <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
            <span class="label">{item.label}</span>
            {#if item.count > 0}
              <span class="count" aria-label={translateCount(i18n.locale, 'mail.messageCount', item.count)}>{item.count > 99 ? '99+' : formatNumber(item.count, i18n.locale)}</span>
            {/if}
          </button>
        {/snippet}
      </Tooltip>
    {/each}
  </nav>

  <div class="label-navigation" aria-label={t('shell.labels')}>
    <div class="label-navigation-heading">
      <span class="label">{t('shell.labels')}</span>
      <Tooltip content={t('label.create')} side="right" floating>
        {#snippet trigger(tooltipId)}
          <button type="button" class="collapse-toggle fm-touch-target" aria-label={t('label.create')} aria-describedby={tooltipId} onclick={() => onCreateLabel?.()}><Plus size={16} aria-hidden="true" /></button>
        {/snippet}
      </Tooltip>
    </div>
    {#each labels as userLabel (userLabel.id)}
      <Tooltip content={userLabel.name} side="right" floating disabled={!collapsed} class="w-full">
        {#snippet trigger(tooltipId)}
          <button type="button" class:active={activeSection === 'label' && activeLabelId === userLabel.id} aria-current={activeSection === 'label' && activeLabelId === userLabel.id ? 'page' : undefined} aria-label={userLabel.name} aria-describedby={collapsed ? tooltipId : undefined} class="fm-touch-target label-item" onclick={() => onSelectLabel?.(userLabel.id)}>
            <Tag size={17} strokeWidth={1.8} aria-hidden="true" /><span class="label">{userLabel.name}</span>
          </button>
        {/snippet}
      </Tooltip>
    {/each}
  </div>

  <p class="powered">{t('shell.powered')}</p>
</aside>

<style>
  .sidebar {
    display: flex;
    min-height: 0;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-2);
    border-right: 1px solid var(--fm-border);
    background: var(--fm-canvas);
  }

  .sidebar-toolbar {
    display: flex;
    justify-content: flex-end;
    min-height: 32px;
  }

  .collapse-toggle {
    display: inline-grid;
    width: 36px;
    height: 32px;
    place-items: center;
    border: 0;
    border-radius: var(--radius-md);
    color: var(--fm-text-muted);
    background: transparent;
    cursor: pointer;
  }

  .collapse-toggle:hover { color: var(--fm-text); background: var(--fm-surface-hover); }

  .label-navigation { min-height: 0; overflow-y: auto; }
  .label-navigation-heading { display: flex; align-items: center; justify-content: space-between; padding-left: var(--space-3); color: var(--fm-text-muted); font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .label-item { display: flex; width: 100%; min-width: 0; align-items: center; gap: var(--space-3); padding: 0 var(--space-3); border: 0; border-radius: var(--radius-md); color: var(--fm-text-secondary); background: transparent; text-align: left; cursor: pointer; }
  .label-item:hover { background: var(--fm-surface-hover); }
  .label-item.active { color: var(--fm-primary); background: var(--fm-primary-soft); }
  .label-item .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .compose {
    display: flex;
    width: 100%;
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

  .collapsed {
    align-items: center;
  }

  .collapsed .sidebar-toolbar {
    justify-content: center;
    width: 100%;
  }

  .collapsed .compose {
    width: 44px;
    padding: 0;
  }

  .collapsed .compose span,
  .collapsed .label,
  .collapsed .powered {
    display: none;
  }

  .collapsed nav {
    width: 100%;
  }

  .collapsed nav button {
    grid-template-columns: 20px;
    justify-content: center;
    padding-inline: 0;
  }

  .collapsed nav .count {
    position: absolute;
    top: 1px;
    right: 1px;
    min-width: 17px;
    padding: 0 4px;
    border: 2px solid var(--fm-canvas);
    font-size: 9px;
    line-height: 14px;
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
    width: 100%;
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
    .sidebar { padding-inline: var(--space-2); }
  }

  @media (max-width: 900px) {
    .sidebar {
      display: none;
    }
  }
</style>
