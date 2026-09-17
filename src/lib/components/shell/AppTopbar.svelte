<script lang="ts">
  import { onMount } from 'svelte';
  import LogOut from '@lucide/svelte/icons/log-out';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Moon from '@lucide/svelte/icons/moon';
  import Rows3 from '@lucide/svelte/icons/rows-3';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import Sun from '@lucide/svelte/icons/sun';
  import type { UserProfile } from '$lib/domain/mail';
  import { applyTheme, readThemePreference, type ThemePreference } from '$lib/theme';
  import { DropdownMenu } from '$lib/components/ui';
  import BrandMark from './BrandMark.svelte';
  import ServiceStatusMenu from './ServiceStatusMenu.svelte';
  import LanguageSwitcher from './LanguageSwitcher.svelte';
  import MailSearchBar from '$lib/components/mail/MailSearchBar.svelte';
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
    searchQuery = '',
    density = 'comfortable',
    pending = false,
    onEditProfile,
    onLogout,
    onSearchQueryChange,
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
    searchQuery?: string;
    density?: 'comfortable' | 'compact';
    pending?: boolean;
    onEditProfile: () => void;
    onLogout: () => void | Promise<void>;
    onSearchQueryChange?: (query: string) => void;
    onToggleDensity?: () => void;
  } = $props();

  let themePreference = $state<ThemePreference>('system');
  let preferencesOpen = $state(false);
  let accountOpen = $state(false);
  let showDesktopSearch = $state(false);
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

    const layoutMedia = matchMedia('(min-width: 901px)');
    const syncDesktopSearch = () => {
      showDesktopSearch = layoutMedia.matches;
    };
    syncDesktopSearch();
    layoutMedia.addEventListener('change', syncDesktopSearch);

    const media = matchMedia('(prefers-color-scheme: dark)');
    const syncThemePreference = (event: Event) => {
      const detail = (event as CustomEvent<{ preference?: ThemePreference }>).detail;
      if (detail?.preference) themePreference = detail.preference;
    };
    const syncSystemTheme = () => {
      if (themePreference === 'system') applyTheme('system');
    };
    media.addEventListener('change', syncSystemTheme);
    window.addEventListener('flaremail:theme-change', syncThemePreference);
    return () => {
      layoutMedia.removeEventListener('change', syncDesktopSearch);
      media.removeEventListener('change', syncSystemTheme);
      window.removeEventListener('flaremail:theme-change', syncThemePreference);
    };
  });

  function setTheme(next: ThemePreference) {
    themePreference = next;
    applyTheme(next);
  }
</script>

<header class="topbar">
  <div class="identity">
    <BrandMark />
    <span class="divider" aria-hidden="true"></span>
    <button class="workspace" type="button" title={`${profile.company || t('shell.workspaceFallback')} · ${profile.email}`} onclick={onEditProfile}>
      <span>{profile.company || t('shell.workspaceFallback')}</span>
      <span class="workspace-account">{profile.email}</span>
    </button>
  </div>

  <div class="topbar-search">
    {#if showDesktopSearch}
      <MailSearchBar id="mail-search-desktop" query={searchQuery} disabled={pending} onQueryChange={onSearchQueryChange} />
      <kbd aria-hidden="true">/</kbd>
    {/if}
  </div>

  <div class="actions" aria-label={t('shell.topbarActions')}>
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

    <DropdownMenu
      id="display-preferences"
      open={preferencesOpen}
      align="end"
      contentRole="dialog"
      showChevron={false}
      triggerAriaLabel={t('shell.displayPreferences')}
      triggerTitle={t('shell.displayPreferences')}
      triggerClass="topbar-icon-trigger"
      onOpenChange={(open) => {
        preferencesOpen = open;
        if (open) accountOpen = false;
      }}
    >
      {#snippet trigger()}
        <Settings2 class="size-[18px]" aria-hidden="true" />
      {/snippet}
      {#snippet children()}
        <div class="preference-panel">
          <section aria-labelledby="display-preferences-theme">
            <h2 id="display-preferences-theme">{t('settings.theme')}</h2>
            <div class="preference-options" role="radiogroup" aria-label={t('settings.theme')}>
              <button class:active={themePreference === 'system'} type="button" role="radio" aria-checked={themePreference === 'system'} onclick={() => setTheme('system')}>
                <Monitor class="size-4" aria-hidden="true" />
                <span>{t('settings.themeSystem')}</span>
              </button>
              <button class:active={themePreference === 'light'} type="button" role="radio" aria-checked={themePreference === 'light'} onclick={() => setTheme('light')}>
                <Sun class="size-4" aria-hidden="true" />
                <span>{t('settings.themeLight')}</span>
              </button>
              <button class:active={themePreference === 'dark'} type="button" role="radio" aria-checked={themePreference === 'dark'} onclick={() => setTheme('dark')}>
                <Moon class="size-4" aria-hidden="true" />
                <span>{t('settings.themeDark')}</span>
              </button>
            </div>
          </section>
          <section aria-labelledby="display-preferences-density">
            <h2 id="display-preferences-density">{t('settings.density')}</h2>
            <div class="preference-options" role="radiogroup" aria-label={t('settings.density')}>
              <button class:active={density === 'comfortable'} type="button" role="radio" aria-checked={density === 'comfortable'} onclick={() => density === 'compact' && onToggleDensity?.()}>
                <Rows3 class="size-4" aria-hidden="true" />
                <span>{t('shell.standardDensity')}</span>
              </button>
              <button class:active={density === 'compact'} type="button" role="radio" aria-checked={density === 'compact'} onclick={() => density === 'comfortable' && onToggleDensity?.()}>
                <Rows3 class="size-4" aria-hidden="true" />
                <span>{t('shell.compactDensity')}</span>
              </button>
            </div>
          </section>
          <div class="preference-language">
            <LanguageSwitcher />
          </div>
        </div>
      {/snippet}
    </DropdownMenu>

    <DropdownMenu
      id="account-menu"
      open={accountOpen}
      align="end"
      triggerAriaLabel={t('shell.accountMenu')}
      triggerTitle={t('shell.accountMenu')}
      triggerClass="account-trigger"
      onOpenChange={(open) => {
        accountOpen = open;
        if (open) preferencesOpen = false;
      }}
    >
      {#snippet trigger()}
        <span class="account-avatar" aria-hidden="true">{initials}</span>
        <span class="account-trigger-label">{profile.name || profile.email}</span>
      {/snippet}
      {#snippet children()}
        <div role="presentation" class="account-summary">
          <strong>{profile.name || t('shell.workspaceFallback')}</strong>
          <span>{profile.email}</span>
        </div>
        <button class="menu-action fm-touch-target" role="menuitem" type="button" onclick={onEditProfile}>
          <Settings2 class="size-4" aria-hidden="true" />{t('shell.openSettings')}
        </button>
        <button class="menu-action fm-touch-target text-[var(--fm-danger)]" role="menuitem" type="button" disabled={pending} onclick={onLogout}>
          <LogOut class="size-4" aria-hidden="true" />{t('shell.logout')}
        </button>
      {/snippet}
    </DropdownMenu>
  </div>
</header>

<style>
  .topbar {
    position: relative;
    z-index: 40;
    display: grid;
    grid-template-columns: minmax(180px, 1fr) minmax(240px, 1.8fr) minmax(152px, auto);
    align-items: center;
    height: 50px;
    gap: var(--space-4);
    padding: 0 var(--space-4);
    border-bottom: 1px solid var(--fm-border);
    background: var(--fm-surface);
  }

  .identity,
  .actions,
  .topbar-search {
    display: flex;
    min-width: 0;
    align-items: center;
  }

  .identity {
    gap: var(--space-3);
  }

  .topbar-search {
    position: relative;
  }

  .topbar-search :global(.relative) {
    width: 100%;
  }

  .topbar-search kbd {
    position: absolute;
    right: 0.5rem;
    display: inline-flex;
    width: 22px;
    height: 22px;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--fm-border);
    border-radius: var(--radius-sm);
    color: var(--fm-text-muted);
    background: var(--fm-surface);
    font: 12px/1 var(--font-sans);
    pointer-events: none;
  }

  .topbar-search :global(input) {
    padding-right: 2.75rem;
  }

  .actions {
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .divider {
    width: 1px;
    height: 24px;
    flex: 0 0 auto;
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
    text-align: start;
  }

  .workspace > span:first-child,
  .workspace-account {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workspace-account {
    color: var(--fm-text-muted);
    font-size: 11px;
    font-weight: 400;
  }

  :global(.topbar-icon-trigger),
  :global(.account-trigger) {
    height: 32px;
    border: 1px solid var(--fm-border);
    border-radius: var(--radius-md);
    color: var(--fm-text-secondary);
    background: var(--fm-surface);
  }

  :global(.topbar-icon-trigger) {
    width: 32px;
  }

  :global(.account-trigger) {
    max-width: 164px;
    padding: 0 8px;
    color: var(--fm-primary);
    font-size: 12px;
    font-weight: 700;
  }

  :global(.topbar-icon-trigger:hover),
  :global(.account-trigger:hover),
  .workspace:hover {
    background: var(--fm-surface-hover);
  }

  .account-avatar {
    display: grid;
    width: 24px;
    height: 24px;
    flex: 0 0 auto;
    place-items: center;
    border-radius: 999px;
    color: var(--fm-primary);
    background: var(--fm-primary-soft);
    font-size: 10px;
    font-weight: 800;
  }

  .account-trigger-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.menu-action) {
    display: flex;
    min-height: 36px;
    width: 100%;
    align-items: center;
    gap: 0.625rem;
    border-radius: var(--radius-md);
    padding: 0.5rem 0.625rem;
    color: var(--fm-text-secondary);
    text-align: start;
  }

  :global(.menu-action:hover) {
    background: var(--fm-surface-hover);
    color: var(--fm-text);
  }

  .account-summary {
    display: grid;
    gap: 2px;
    min-width: 180px;
    padding: 0.5rem 0.625rem 0.625rem;
    border-bottom: 1px solid var(--fm-border);
  }

  .account-summary strong,
  .account-summary span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account-summary strong {
    color: var(--fm-text);
    font-size: 13px;
  }

  .account-summary span {
    color: var(--fm-text-muted);
    font-size: 11px;
  }

  .preference-panel {
    display: grid;
    width: min(20rem, calc(100vw - 2rem));
    gap: 1rem;
    padding: 0.5rem;
  }

  .preference-panel section {
    display: grid;
    gap: 0.375rem;
  }

  .preference-panel h2 {
    color: var(--fm-text-muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .preference-options {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.25rem;
  }

  .preference-options button {
    display: grid;
    min-height: 56px;
    min-width: 0;
    place-items: center;
    gap: 0.25rem;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    padding: 0.375rem;
    color: var(--fm-text-secondary);
    font-size: 11px;
    text-align: center;
  }

  .preference-options button:hover,
  .preference-options button.active {
    border-color: var(--fm-primary);
    color: var(--fm-primary);
    background: var(--fm-primary-soft);
  }

  .preference-language {
    border-top: 1px solid var(--fm-border);
    padding-top: 0.75rem;
  }

  .preference-language :global(.language-switcher) {
    width: 100%;
  }

  @media (max-width: 1100px) {
    .topbar {
      grid-template-columns: minmax(132px, 0.9fr) minmax(200px, 1.4fr) minmax(152px, auto);
      gap: var(--space-3);
    }

    .workspace-account {
      display: none;
    }

    .workspace > span:first-child {
      max-width: 150px;
    }

    .account-trigger-label {
      display: none;
    }
  }

  @media (max-width: 900px) {
    .topbar {
      display: none;
    }
  }
</style>
