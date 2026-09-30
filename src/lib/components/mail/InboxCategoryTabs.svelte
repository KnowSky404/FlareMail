<script lang="ts">
  import { Inbox, LayoutList, Megaphone, Users, Bell, MessagesSquare } from '@lucide/svelte';
  import type { InboxCategoryFilter } from '$lib/domain/mail';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let { category = 'all', onChange }: { category?: InboxCategoryFilter; onChange: (category: InboxCategoryFilter) => void } = $props();
  const { t } = useLocale();
  const categories = [
    { id: 'all', icon: LayoutList }, { id: 'primary', icon: Inbox },
    { id: 'promotions', icon: Megaphone }, { id: 'social', icon: Users },
    { id: 'updates', icon: Bell }, { id: 'forums', icon: MessagesSquare }
  ] as const;

  function navigate(event: KeyboardEvent, index: number) {
    const next = event.key === 'ArrowRight' ? (index + 1) % categories.length
      : event.key === 'ArrowLeft' ? (index - 1 + categories.length) % categories.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? categories.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const buttons = event.currentTarget instanceof HTMLElement ? event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') : null;
    buttons?.[next]?.focus();
    buttons?.[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    onChange(categories[next].id);
  }
</script>

<div class="inbox-category-tabs" role="tablist" aria-label={t('mail.categories')} title={t('mail.category.hint')}>
  {#each categories as item, index (item.id)}
    <button id={`inbox-tab-${item.id}`} type="button" role="tab" aria-selected={category === item.id} aria-controls="inbox-category-panel"
      tabindex={category === item.id ? 0 : -1} onclick={() => onChange(item.id)} onkeydown={(event) => navigate(event, index)}>
      <item.icon size={17} aria-hidden="true" />
      <span>{t(`mail.category.${item.id}`)}</span>
    </button>
  {/each}
</div>

<style>
  .inbox-category-tabs { display: flex; flex: 0 0 auto; min-width: 0; overflow-x: auto; border-bottom: 1px solid var(--fm-border); background: var(--fm-surface); scrollbar-width: thin; }
  button { position: relative; display: inline-flex; flex: 1 0 100px; min-height: 52px; align-items: center; justify-content: flex-start; gap: 10px; padding: 0 20px; border: 0; background: transparent; color: var(--fm-text-secondary); font: 500 13px/1.4 var(--font-sans); cursor: pointer; white-space: nowrap; }
  button:hover { background: var(--fm-surface-hover); }
  button[aria-selected='true'] { color: var(--fm-primary); font-weight: 650; }
  button[aria-selected='true']::after { position: absolute; bottom: 0; right: 12px; left: 12px; height: 3px; border-radius: 3px 3px 0 0; background: var(--fm-primary); content: ''; }
  button:focus-visible { outline: 2px solid var(--fm-focus); outline-offset: -3px; }
  @media (max-width: 900px) { button { min-height: 48px; flex: 0 0 auto; padding-inline: 16px; } }
</style>
