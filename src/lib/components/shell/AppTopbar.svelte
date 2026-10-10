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
  import { Avatar, DropdownMenu } from '$lib/components/ui';
  import { nextRadioIndex } from '$lib/components/ui/radio-navigation';
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
  const themeChoices = ['system', 'light', 'dark'] as const;
  const densityChoices = ['comfortable', 'compact'] as const;

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

  function setDensity(next: 'comfortable' | 'compact') {
    if (next !== density) onToggleDensity?.();
  }

  function handlePreferenceRadioKeydown<T extends string>(
    event: KeyboardEvent,
    values: readonly T[],
    select: (value: T) => void
  ) {
    const currentButton = event.currentTarget as HTMLButtonElement;
    const group = currentButton.parentElement;
    if (!group) return;
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const nextIndex = nextRadioIndex(event.key, buttons.indexOf(currentButton), buttons.length);
    if (nextIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    select(values[nextIndex]);
    buttons[nextIndex]?.focus({ preventScroll: true });
  }
</script>

<header class="topbar">
  <div class="identity">
    <BrandMark />
  </div>

  <div class="topbar-search">
    {#if showDesktopSearch}
      <MailSearchBar id="mail-search-desktop" query={searchQuery} disabled={pending} onQueryChange={onSearchQueryChange} />
      {#if !searchQuery}
        <kbd aria-hidden="true">/</kbd>
      {/if}
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
      initialFocusSelector='[role="radiogroup"] [role="radio"][aria-checked="true"]'
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
              <button class:active={themePreference === 'system'} type="button" role="radio" aria-checked={themePreference === 'system'} tabindex={themePreference === 'system' ? 0 : -1} onclick={() => setTheme('system')} onkeydown={(event) => handlePreferenceRadioKeydown(event, themeChoices, setTheme)}>
                <Monitor class="size-4" aria-hidden="true" />
                <span>{t('settings.themeSystem')}</span>
              </button>
              <button class:active={themePreference === 'light'} type="button" role="radio" aria-checked={themePreference === 'light'} tabindex={themePreference === 'light' ? 0 : -1} onclick={() => setTheme('light')} onkeydown={(event) => handlePreferenceRadioKeydown(event, themeChoices, setTheme)}>
                <Sun class="size-4" aria-hidden="true" />
                <span>{t('settings.themeLight')}</span>
              </button>
              <button class:active={themePreference === 'dark'} type="button" role="radio" aria-checked={themePreference === 'dark'} tabindex={themePreference === 'dark' ? 0 : -1} onclick={() => setTheme('dark')} onkeydown={(event) => handlePreferenceRadioKeydown(event, themeChoices, setTheme)}>
                <Moon class="size-4" aria-hidden="true" />
                <span>{t('settings.themeDark')}</span>
              </button>
            </div>
          </section>
          <section aria-labelledby="display-preferences-density">
            <h2 id="display-preferences-density">{t('settings.density')}</h2>
            <div class="preference-options" role="radiogroup" aria-label={t('settings.density')}>
              <button class:active={density === 'comfortable'} type="button" role="radio" aria-checked={density === 'comfortable'} tabindex={density === 'comfortable' ? 0 : -1} onclick={() => setDensity('comfortable')} onkeydown={(event) => handlePreferenceRadioKeydown(event, densityChoices, setDensity)}>
                <Rows3 class="size-4" aria-hidden="true" />
                <span>{t('shell.standardDensity')}</span>
              </button>
              <button class:active={density === 'compact'} type="button" role="radio" aria-checked={density === 'compact'} tabindex={density === 'compact' ? 0 : -1} onclick={() => setDensity('compact')} onkeydown={(event) => handlePreferenceRadioKeydown(event, densityChoices, setDensity)}>
                <Rows3 class="size-4" aria-hidden="true" />
                <span>{t('shell.compactDensity')}</span>
              </button>
            </div>
          </section>
          <section aria-labelledby="display-preferences-language">
            <h2 id="display-preferences-language">{t('settings.language')}</h2>
            <LanguageSwitcher variant="segmented" class="preference-options" />
          </section>
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
        <Avatar name={profile.name} {initials} size="xs" />
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
    grid-template-columns: 216px minmax(240px, 720px) minmax(136px, 1fr);
    align-items: center;
    height: var(--fm-desktop-topbar-height);
    gap: var(--space-4);
    padding: 0 var(--space-4);
    background: var(--fm-canvas);
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
    --brand-mark-size: 32px;
    --brand-wordmark-size: 18px;
  }

  .topbar-search {
    position: relative;
    justify-content: center;
    width: 100%;
    max-width: 45rem;
    justify-self: start;
  }

  .topbar-search :global(.mail-search-root) {
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
    background: transparent;
    font: 12px/1 var(--font-sans);
    pointer-events: none;
  }

  .topbar-search :global(input) {
    height: 36px;
    padding-right: 2.75rem;
    border: 0;
    border-radius: var(--radius-pill);
    background: var(--fm-search-surface);
  }

  .actions {
    justify-content: flex-end;
    gap: var(--space-2);
  }

  :global(.topbar-icon-trigger),
  :global(.account-trigger) {
    height: 40px;
    border: 0;
    border-radius: var(--radius-pill);
    color: var(--fm-text-secondary);
    background: transparent;
  }

  :global(.topbar-icon-trigger) {
    width: 40px;
  }

  :global(.account-trigger) {
    padding: 0 7px;
    color: var(--fm-primary);
    font-size: 12px;
    font-weight: 700;
  }

  :global(.topbar-icon-trigger:hover),
  :global(.account-trigger:hover) {
    background: var(--fm-surface-hover);
  }

  .account-trigger-label {
    display: none;
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

  .preference-panel :global(.preference-options) {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.25rem;
  }

  .preference-panel :global(.preference-options button) {
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

  .preference-panel :global(.preference-options button:hover),
  .preference-panel :global(.preference-options button.active) {
    border-color: var(--fm-primary);
    color: var(--fm-primary);
    background: var(--fm-primary-soft);
  }

  .preference-panel :global(.preference-options button:focus-visible) {
    outline: 2px solid var(--fm-focus);
    outline-offset: 2px;
  }

  @media (max-width: 1100px) {
    .topbar {
      grid-template-columns: minmax(160px, 0.9fr) minmax(200px, 1.4fr) minmax(136px, auto);
      gap: var(--space-3);
    }


  }

  @media (max-width: 900px) {
    .topbar {
      display: none;
    }
  }
</style>
