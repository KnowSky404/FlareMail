<script lang="ts">
  import { tick } from 'svelte';
  import Info from '@lucide/svelte/icons/info';
  import LogOut from '@lucide/svelte/icons/log-out';
  import type { UserProfile } from '$lib/domain/mail';
  import { Avatar, DropdownMenu } from '$lib/components/ui';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    id = 'account-menu',
    profile,
    open = false,
    pending = false,
    onOpenChange,
    onOpenAbout,
    onLogout
  }: {
    id?: string;
    profile: UserProfile;
    open?: boolean;
    pending?: boolean;
    onOpenChange: (open: boolean) => void;
    onOpenAbout: (trigger: HTMLElement | null) => void;
    onLogout: () => void | Promise<void>;
  } = $props();

  const { t } = useLocale();
  let rootElement = $state<HTMLDivElement>();
  const initials = $derived(profile.name.trim().slice(0, 2).toUpperCase() || 'FM');

  async function openAbout() {
    const trigger = rootElement?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]') ?? null;
    onOpenChange(false);
    await tick();
    onOpenAbout(trigger);
  }
</script>

<div class="account-control" bind:this={rootElement}>
  <DropdownMenu {id} {open} align="end" triggerAriaLabel={t('shell.accountMenu')} triggerTitle={t('shell.accountMenu')} triggerClass="account-trigger" {onOpenChange}>
    {#snippet trigger()}
      <Avatar name={profile.name} {initials} size="xs" />
    {/snippet}
    {#snippet children()}
      <div role="presentation" class="account-summary">
        <strong>{profile.name || t('shell.workspaceFallback')}</strong>
        <span>{profile.email}</span>
      </div>
      <button class="account-action fm-touch-target" role="menuitem" type="button" onclick={openAbout}>
        <Info class="size-4" aria-hidden="true" />{t('shell.about')}
      </button>
      <button class="account-action fm-touch-target text-[var(--fm-danger)]" role="menuitem" type="button" disabled={pending} onclick={onLogout}>
        <LogOut class="size-4" aria-hidden="true" />{t('shell.logout')}
      </button>
    {/snippet}
  </DropdownMenu>
</div>

<style>
  .account-control { display: inline-flex; flex: none; }
  .account-control :global(.account-trigger) {
    height: 40px;
    padding: 0 7px;
    border: 0;
    border-radius: var(--radius-pill);
    color: var(--fm-primary);
    background: transparent;
    font-size: 12px;
    font-weight: 700;
  }
  .account-control :global(.account-trigger:hover), .account-action:hover { background: var(--fm-surface-hover); }
  .account-action {
    display: flex;
    min-height: 36px;
    width: 100%;
    align-items: center;
    gap: 0.625rem;
    border-radius: var(--radius-md);
    padding: 0.5rem 0.625rem;
    text-align: start;
  }
  .account-summary {
    display: grid;
    gap: 2px;
    min-width: 180px;
    padding: 0.5rem 0.625rem 0.625rem;
    border-bottom: 1px solid var(--fm-border);
  }
  .account-summary strong, .account-summary span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .account-summary strong { color: var(--fm-text); font-size: 13px; }
  .account-summary span { color: var(--fm-text-muted); font-size: 11px; }
  @media (max-width: 900px) {
    .account-control :global(.account-trigger) { min-width: 44px; min-height: 44px; }
    .account-action { min-height: 44px; }
  }
</style>
