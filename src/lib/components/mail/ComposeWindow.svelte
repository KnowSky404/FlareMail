<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { Maximize2, Minimize2, Move, MoveDiagonal2, Square, X } from '@lucide/svelte';
  import { IconButton } from '$lib/components/ui';
  import { buttonClass } from '$lib/components/ui/styles';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  type Bounds = { x: number; y: number; width: number; height: number };
  type PointerSession = { pointerId: number; x: number; y: number; bounds: Bounds };

  let {
    id,
    title,
    description,
    mobileStatus,
    mobileStatusTone = 'text-[var(--fm-text-muted)]',
    children,
    footer,
    onClose
  }: {
    id: string;
    title: string;
    description?: string;
    mobileStatus?: string;
    mobileStatusTone?: string;
    children?: Snippet;
    footer?: Snippet;
    onClose: () => void;
  } = $props();

  const { t } = useLocale();
  const defaultWidth = 760;
  const defaultHeight = 640;
  const minWidth = 480;
  const minHeight = 360;
  let element = $state<HTMLDivElement>();
  let bounds = $state<Bounds>({ x: 16, y: 16, width: defaultWidth, height: defaultHeight });
  let minimized = $state(false);
  let maximized = $state(false);
  let mobile = $state(false);
  let drag: PointerSession | null = null;
  let resize: PointerSession | null = null;
  const panelStyle = $derived(minimized
    ? 'right:16px;bottom:16px;width:min(320px,calc(100vw - 32px));height:auto;'
    : maximized
      ? 'left:16px;top:16px;width:calc(100vw - 32px);height:calc(100dvh - 32px);'
      : `left:${bounds.x}px;top:${bounds.y}px;width:${bounds.width}px;height:${bounds.height}px;`);

  function onMobile() {
    return mobile;
  }

  function initialBounds(): Bounds {
    const width = Math.min(defaultWidth, Math.max(1, window.innerWidth - 32));
    const height = Math.min(defaultHeight, Math.max(1, window.innerHeight - 32));
    return { x: Math.max(16, window.innerWidth - width - 24), y: Math.max(16, window.innerHeight - height - 24), width, height };
  }

  function fitToViewport(value: Bounds): Bounds {
    const width = Math.min(Math.max(minWidth, value.width), Math.max(1, window.innerWidth - 32));
    const height = Math.min(Math.max(minHeight, value.height), Math.max(1, window.innerHeight - 32));
    return {
      x: Math.max(8, Math.min(value.x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(value.y, window.innerHeight - height - 8)),
      width,
      height
    };
  }

  function startDrag(event: PointerEvent) {
    if (event.button !== 0 || minimized || maximized || onMobile()) return;
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, bounds: { ...bounds } };
    event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveDrag(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    bounds = fitToViewport({ ...drag.bounds, x: drag.bounds.x + event.clientX - drag.x, y: drag.bounds.y + event.clientY - drag.y });
  }

  function stopDrag(event: PointerEvent) {
    if (drag?.pointerId === event.pointerId) drag = null;
  }

  function moveByKeyboard(event: KeyboardEvent) {
    if (maximized || minimized) return;
    const step = event.shiftKey ? 64 : 24;
    const x = bounds.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0);
    const y = bounds.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
    if (event.key === 'Home') {
      event.preventDefault();
      bounds = { ...bounds, x: initialBounds().x, y: initialBounds().y };
    } else if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      bounds = fitToViewport({ ...bounds, x, y });
    }
  }

  function resizeTo(width: number, height: number, starting: Bounds) {
    const right = starting.x + starting.width;
    const bottom = starting.y + starting.height;
    const nextWidth = Math.min(Math.max(minWidth, width), right - 8);
    const nextHeight = Math.min(Math.max(minHeight, height), bottom - 8);
    bounds = { x: right - nextWidth, y: bottom - nextHeight, width: nextWidth, height: nextHeight };
  }

  function startResize(event: PointerEvent) {
    if (event.button !== 0 || minimized || maximized || onMobile()) return;
    resize = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, bounds: { ...bounds } };
    event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function moveResize(event: PointerEvent) {
    if (!resize || resize.pointerId !== event.pointerId) return;
    resizeTo(resize.bounds.width - (event.clientX - resize.x), resize.bounds.height - (event.clientY - resize.y), resize.bounds);
  }

  function stopResize(event: PointerEvent) {
    if (resize?.pointerId === event.pointerId) resize = null;
  }

  function resizeByKeyboard(event: KeyboardEvent) {
    if (maximized || minimized) return;
    const step = event.shiftKey ? 64 : 24;
    const width = bounds.width + (event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0);
    const height = bounds.height + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0);
    if (event.key === 'Home') {
      event.preventDefault();
      bounds = initialBounds();
    } else if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      resizeTo(width, height, bounds);
    }
  }

  function toggleMinimized() {
    minimized = !minimized;
    if (minimized) requestAnimationFrame(() => element?.querySelector<HTMLButtonElement>(`[aria-label="${t('compose.restoreWindow')}"]`)?.focus());
    else requestAnimationFrame(() => element?.querySelector<HTMLInputElement>('#compose-to')?.focus());
  }

  function restoreExistingCompose() {
    minimized = false;
    requestAnimationFrame(() => element?.querySelector<HTMLInputElement>('#compose-to')?.focus());
  }

  function handleKeydown(event: KeyboardEvent) {
    if (mobile && event.key === 'Tab' && element) {
      const focusable = [...element.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((candidate) => candidate.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
    }
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.stopPropagation();
      onClose();
    }
  }

  onMount(() => {
    const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    bounds = initialBounds();
    const mobileMedia = window.matchMedia('(max-width: 640px)');
    mobile = mobileMedia.matches;
    const frame = requestAnimationFrame(() => element?.querySelector<HTMLInputElement>('#compose-to')?.focus());
    const onViewportResize = () => { bounds = fitToViewport(bounds); };
    const onMobileChange = () => { mobile = mobileMedia.matches; };
    window.addEventListener('resize', onViewportResize);
    window.addEventListener('flaremail:restore-compose', restoreExistingCompose);
    mobileMedia.addEventListener('change', onMobileChange);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onViewportResize);
      window.removeEventListener('flaremail:restore-compose', restoreExistingCompose);
      mobileMedia.removeEventListener('change', onMobileChange);
      restoreFocus?.focus();
    };
  });
</script>

<div
  bind:this={element}
  {id}
  class="compose-window compose-dialog"
  class:minimized
  class:maximized
  style={panelStyle}
  role="dialog"
  tabindex="-1"
  aria-modal={mobile}
  aria-labelledby={`${id}-title`}
  aria-describedby={description && !minimized ? `${id}-description` : undefined}
  data-minimized={minimized}
  data-maximized={maximized}
  onkeydown={handleKeydown}
>
  <div class="compose-window-header">
    <div class="mobile-close">
      <IconButton ariaLabel={t('common.close')} title={t('common.close')} size="sm" onclick={onClose}><X class="size-5" aria-hidden="true" /></IconButton>
    </div>
    <button
      class={buttonClass('ghost', 'sm', 'resize-handle !min-w-8 !p-0 max-sm:!hidden')}
      type="button"
      aria-label={t('compose.resizeWindow')}
      title={t('compose.resizeWindowHint')}
      onpointerdown={startResize}
      onpointermove={moveResize}
      onpointerup={stopResize}
      onpointercancel={stopResize}
      onkeydown={resizeByKeyboard}
      disabled={minimized || maximized}
    ><MoveDiagonal2 class="size-4" aria-hidden="true" /></button>
    <button
      class={buttonClass('ghost', 'sm', 'move-handle !min-w-8 !p-0 max-sm:!hidden')}
      type="button"
      aria-label={t('compose.moveWindow')}
      title={t('compose.moveWindowHint')}
      onpointerdown={startDrag}
      onpointermove={moveDrag}
      onpointerup={stopDrag}
      onpointercancel={stopDrag}
      onkeydown={moveByKeyboard}
      disabled={minimized || maximized}
    ><Move class="size-4" aria-hidden="true" /></button>
    <div class="header-heading min-w-0 flex-1">
      <h2 id={`${id}-title`} class="truncate text-sm font-semibold text-[var(--fm-text)]">{title}</h2>
      {#if description && !minimized}<p id={`${id}-description`} class="truncate text-xs text-[var(--fm-text-muted)]">{description}</p>{/if}
      {#if mobileStatus}<p class={`mobile-status truncate text-xs ${mobileStatusTone}`} aria-hidden="true">{mobileStatus}</p>{/if}
    </div>
    <div class="desktop-controls flex shrink-0 items-center gap-1">
      {#if minimized}
        <IconButton ariaLabel={t('compose.restoreWindow')} title={t('compose.restoreWindow')} size="sm" tooltipSide="top" onclick={toggleMinimized}><Square class="size-4" aria-hidden="true" /></IconButton>
      {:else}
        <IconButton ariaLabel={t('compose.minimizeWindow')} title={t('compose.minimizeWindow')} size="sm" containerClass="max-sm:!hidden" class="max-sm:!hidden" onclick={toggleMinimized}><Minimize2 class="size-4" aria-hidden="true" /></IconButton>
        <IconButton ariaLabel={maximized ? t('compose.restoreWindow') : t('compose.maximizeWindow')} title={maximized ? t('compose.restoreWindow') : t('compose.maximizeWindow')} size="sm" containerClass="max-sm:!hidden" class="max-sm:!hidden" onclick={() => (maximized = !maximized)}><Maximize2 class="size-4" aria-hidden="true" /></IconButton>
      {/if}
      <IconButton ariaLabel={t('common.close')} title={t('common.close')} size="sm" onclick={onClose}><X class="size-4" aria-hidden="true" /></IconButton>
    </div>
  </div>
  {#if !minimized}
    {#if children}<div class="compose-window-body">{@render children()}</div>{/if}
    {#if footer}<div class="compose-window-footer">{@render footer()}</div>{/if}
  {/if}
</div>

<style>
  .compose-window {
    position: fixed;
    z-index: 50;
    display: flex;
    min-width: 0;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--fm-border);
    border-radius: var(--radius-lg);
    background: var(--fm-surface);
    box-shadow: var(--fm-shadow-overlay);
  }
  .compose-window-header {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
    min-height: 56px;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--fm-border);
    background: var(--fm-surface-subtle);
    cursor: default;
  }
  .compose-window-header button { cursor: pointer; }
  .mobile-close, .mobile-status { display: none; }
  .compose-window-header .resize-handle { cursor: nwse-resize; touch-action: none; }
  .compose-window-header .move-handle { cursor: move; touch-action: none; }
  .compose-window-body { min-height: 0; flex: 1; overflow: auto; padding: var(--space-4); }
  .compose-window-footer { flex: none; border-top: 1px solid var(--fm-border); padding: var(--space-3) var(--space-4); }
  .minimized .compose-window-header { border-bottom: 0; }
  @media (max-width: 640px) {
    .compose-window { inset: 0 !important; width: 100vw !important; height: 100dvh !important; border: 0; border-radius: 0; }
    .compose-window-header { display: grid; grid-template-columns: 44px minmax(0, 1fr) 44px; min-height: 64px; padding: calc(var(--space-2) + env(safe-area-inset-top)) var(--space-3) var(--space-2); background: var(--fm-surface); cursor: default; touch-action: auto; }
    .mobile-close, .mobile-status { display: block; }
    .header-heading { text-align: center; }
    .header-heading h2 { font-size: 1rem; }
    .header-heading > p:not(.mobile-status) { display: none; }
    .desktop-controls { display: none; }
    .compose-window-body { padding: 0; }
    .compose-window-footer { padding: var(--space-2) var(--space-3); }
  }
</style>
