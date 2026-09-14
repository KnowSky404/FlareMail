<script lang="ts">
  import { onMount } from 'svelte';
  import LogOut from '@lucide/svelte/icons/log-out';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Moon from '@lucide/svelte/icons/moon';
  import Search from '@lucide/svelte/icons/search';
  import Settings from '@lucide/svelte/icons/settings';
  import Sun from '@lucide/svelte/icons/sun';
  import Rows3 from '@lucide/svelte/icons/rows-3';
  import type { UserProfile } from '$lib/domain/mail';
  import {
    applyTheme,
    nextThemePreference,
    readThemePreference,
    type ThemePreference
  } from '$lib/theme';
  import BrandMark from './BrandMark.svelte';
  import ServiceStatusMenu from './ServiceStatusMenu.svelte';
  import LanguageSwitcher from './LanguageSwitcher.svelte';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    profile,
    runtimeLabel,
    unreadCount,
    draftCount,
    queuedCount,
    delayedCount,
    failedCount,
    bouncedCount,
    complainedCount,
    staleDeliveryCount,
    serviceDegraded,
    density = 'comfortable',
    pending = false,
    onEditProfile,
    onLogout,
    onSearch,
    onToggleDensity
  }: {
    profile: UserProfile;
    runtimeLabel: string;
    unreadCount: number;
    draftCount: number;
    queuedCount: number;
    delayedCount: number;
    failedCount: number;
    bouncedCount: number;
    complainedCount: number;
    staleDeliveryCount: number;
    serviceDegraded: boolean;
    density?: 'comfortable' | 'compact';
    pending?: boolean;
    onEditProfile: () => void;
    onLogout: () => void | Promise<void>;
    onSearch: () => void;
    onToggleDensity?: () => void;
  } = $props();

  let themePreference = $state<ThemePreference>('system');
  const { t } = useLocale();

  const themeLabel = $derived(
    themePreference === 'system'
      ? t('shell.themeSystem')
      : themePreference === 'light'
        ? t('shell.themeLight')
        : t('shell.themeDark')
  );
  const initials = $derived(profile.name.trim().slice(0, 2).toUpperCase() || 'FM');

  onMount(() => {
    themePreference = readThemePreference();
    applyTheme(themePreference);

    const media = matchMedia('(prefers-color-scheme: dark)');
    const syncThemePreference = (event: Event) => {
      const detail = (event as CustomEvent<{ preference?: ThemePreference }>).detail;
      if (detail?.preference) themePreference = detail.preference;
    };
    const syncSystemTheme = () => {
      if (themePreference === 'system') {
        applyTheme('system');
      }
    };
    media.addEventListener('change', syncSystemTheme);
    window.addEventListener('flaremail:theme-change', syncThemePreference);
    return () => {
      media.removeEventListener('change', syncSystemTheme);
      window.removeEventListener('flaremail:theme-change', syncThemePreference);
    };
  });

  function cycleTheme() {
    themePreference = nextThemePreference(themePreference);
    applyTheme(themePreference);
  }
</script>

<header class="topbar">
  <div class="identity">
    <BrandMark />
    <span class="divider" aria-hidden="true"></span>
    <button class="workspace" type="button" onclick={onEditProfile}>
      <span>{profile.company || t('shell.workspaceFallback')}</span>
      <span class="workspace-account">{profile.email}</span>
    </button>
  </div>

  <button class="command" type="button" onclick={onSearch}>
    <Search size={16} aria-hidden="true" />
    <span>{t('mail.search')}</span>
    <kbd>/</kbd>
  </button>

  <div class="actions">
    <ServiceStatusMenu
      {draftCount}
      {bouncedCount}
      {complainedCount}
      {delayedCount}
      {failedCount}
      {queuedCount}
      {runtimeLabel}
      {serviceDegraded}
      {staleDeliveryCount}
      {unreadCount}
    />
    <LanguageSwitcher />
    <button class="icon-button" type="button" aria-label={themeLabel} title={themeLabel} onclick={cycleTheme}>
      {#if themePreference === 'system'}
        <Monitor size={18} aria-hidden="true" />
      {:else if themePreference === 'light'}
        <Sun size={18} aria-hidden="true" />
      {:else}
        <Moon size={18} aria-hidden="true" />
      {/if}
    </button>
    <button class="icon-button" type="button" aria-label={density === 'compact' ? t('shell.compactDensity') : t('shell.standardDensity')} title={density === 'compact' ? t('shell.standardDensity') : t('shell.compactDensity')} aria-pressed={density === 'compact'} onclick={() => onToggleDensity?.()}>
      <Rows3 size={18} aria-hidden="true" />
    </button>
    <button class="profile-button" type="button" aria-label={t('shell.openSettings')} onclick={onEditProfile}>
      <span>{initials}</span><Settings size={14} aria-hidden="true" />
    </button>
    <button class="icon-button" type="button" aria-label={t('shell.logout')} disabled={pending} onclick={onLogout}>
      <LogOut size={18} aria-hidden="true" />
    </button>
  </div>
</header>

<style>
  .topbar {
    position: relative;
    z-index: 40;
    display: grid;
    grid-template-columns: minmax(260px, 1fr) minmax(280px, 560px) minmax(260px, 1fr);
    align-items: center;
    height: 50px;
    padding: 0 var(--space-4);
    border-bottom: 1px solid var(--fm-border);
    background: var(--fm-surface);
  }

  .identity,
  .actions {
    display: flex;
    min-width: 0;
    align-items: center;
  }

  .identity {
    gap: var(--space-4);
  }

  .actions {
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .divider {
    width: 1px;
    height: 24px;
    background: var(--fm-border);
  }

  .workspace {
    display: flex;
    min-width: 0;
    flex-direction: column;
    align-items: flex-start;
    padding: 2px 0;
    border: 0;
    color: var(--fm-text);
    background: transparent;
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.2;
  }

  .workspace-account {
    max-width: 180px;
    overflow: hidden;
    color: var(--fm-text-muted);
    font-size: 11px;
    font-weight: 400;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .command {
    display: flex;
    min-width: 0;
    height: var(--control-default);
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    border: 1px solid var(--fm-border);
    border-radius: var(--radius-md);
    color: var(--fm-text-muted);
    background: var(--fm-surface-subtle);
    cursor: pointer;
    font-size: 13px;
    text-align: left;
  }

  .command span {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  kbd {
    display: inline-flex;
    min-width: 22px;
    height: 22px;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--fm-border);
    border-radius: var(--radius-sm);
    color: var(--fm-text-muted);
    background: var(--fm-surface);
    font: 12px/1 var(--font-sans);
  }

  .icon-button,
  .profile-button {
    display: inline-flex;
    height: var(--control-default);
    align-items: center;
    justify-content: center;
    border: 1px solid var(--fm-border);
    border-radius: var(--radius-md);
    color: var(--fm-text-secondary);
    background: var(--fm-surface);
    cursor: pointer;
  }

  .icon-button {
    width: var(--control-default);
  }

  .profile-button {
    gap: 6px;
    padding: 0 9px;
    color: var(--fm-primary);
    font-size: 12px;
    font-weight: 700;
  }

  .icon-button:hover:not(:disabled),
  .profile-button:hover,
  .command:hover,
  .workspace:hover {
    background: var(--fm-surface-hover);
  }

  .icon-button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  @media (max-width: 1023px) {
    .topbar {
      grid-template-columns: minmax(220px, 1fr) minmax(220px, 360px) auto;
    }

    .workspace-account,
    .profile-button,
    .actions :global(.status-menu) {
      display: none;
    }
  }

  @media (max-width: 900px) {
    .topbar {
      display: none;
    }
  }
</style>
