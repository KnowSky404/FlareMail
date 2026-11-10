<script module lang="ts">
  const uncertainReleases = new Set<string>();
  const uncertainReleaseKey = 'flaremail-uncertain-quarantine-releases';

  function restoreUncertainReleases() {
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(uncertainReleaseKey) ?? '[]');
      if (Array.isArray(stored)) {
        for (const id of stored) if (typeof id === 'string' && id.length > 0 && id.length <= 256) uncertainReleases.add(id);
      }
    } catch { /* Session storage may be unavailable. */ }
  }

  function rememberRelease(id: string, pending: boolean) {
    if (pending) uncertainReleases.add(id);
    else uncertainReleases.delete(id);
    try {
      if (uncertainReleases.size) sessionStorage.setItem(uncertainReleaseKey, JSON.stringify([...uncertainReleases]));
      else sessionStorage.removeItem(uncertainReleaseKey);
    } catch { /* Keep the in-memory retry state when storage is unavailable. */ }
  }
</script>

<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import TextField from '$lib/components/ui/TextField.svelte';
  import { ClientApiError, requestJson } from '$lib/client/api';
  import { AUTH_EXPIRED_EVENT } from '$lib/client/auth-session';
  import { createWorkspaceSync, WORKSPACE_SESSION_ENDED_EVENT } from '$lib/client/workspace-sync';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  type Sender = { email: string; createdAt: string };
  type Quarantined = { id: string; sender: string; subject: string; timestamp: string };
  type QuarantinePage = { items: Quarantined[]; previousCursor: string | null; nextCursor: string | null };
  type PageTarget = { cursor: string | null; direction: 'next' | 'previous'; number: number };
  let { active, onRelease, onPageChange }: {
    active: boolean; onRelease?: (id: string) => void; onPageChange?: (cursor: string | null, page: number, direction: 'next' | 'previous') => void | Promise<void>;
  } = $props();
  const { t } = useLocale();
  let email = $state('');
  let senders = $state<Sender[]>([]);
  let page = $state<QuarantinePage>({ items: [], previousCursor: null, nextCursor: null });
  let position = $state<PageTarget>({ cursor: null, direction: 'next', number: 1 });
  let retryTarget = $state<PageTarget | null>(null);
  let mounted = $state(false);
  let loaded = $state(false);
  let loading = $state(false);
  let pending = $state(false);
  let error = $state('');
  let operationError = $state('');
  let status = $state('');
  let refreshRequested = $state(true);
  let generation = 0;
  let navigationRevision = 0;
  let sessionRequests = new AbortController();
  let sync: ReturnType<typeof createWorkspaceSync> | null = null;

  function positionFromUrl(): PageTarget {
    const params = new URL(window.location.href).searchParams;
    const cursor = params.get('quarantineCursor');
    const number = Number(params.get('quarantinePage'));
    const direction = params.get('quarantineDirection') === 'previous' ? 'previous' : 'next';
    if (cursor && /^[A-Za-z0-9_-]{1,4096}$/u.test(cursor) && Number.isSafeInteger(number) && number >= 2 && number <= 1_000_000) {
      return { cursor, direction, number };
    }
    return { cursor: null, direction: 'next', number: 1 };
  }

  onMount(() => {
    restoreUncertainReleases();
    mounted = true;
    sync = createWorkspaceSync((event) => {
      if (event.type === 'blocked-senders-changed' || event.type === 'mailbox-refresh') refreshRequested = true;
    });
    const restorePosition = () => { retryTarget = null; error = ''; refreshRequested = true; };
    const expire = () => {
      generation++;
      sessionRequests.abort();
      sessionRequests = new AbortController();
      senders = []; page = { items: [], previousCursor: null, nextCursor: null }; position = { cursor: null, direction: 'next', number: 1 };
      retryTarget = null; loaded = false; loading = false; pending = false; error = ''; operationError = ''; status = '';
      onPageChange?.(null, 1, 'next');
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, expire);
    window.addEventListener('popstate', restorePosition);
    return () => {
      generation++; sessionRequests.abort();
      sync?.close(); sync = null;
      window.removeEventListener(AUTH_EXPIRED_EVENT, expire);
      window.removeEventListener('popstate', restorePosition);
    };
  });

  async function load(target: PageTarget, revision: number) {
    const current = generation;
    const signal = sessionRequests.signal;
    error = '';
    try {
      const query = new URLSearchParams();
      if (target.cursor) query.set('cursor', target.cursor);
      if (target.direction === 'previous') query.set('direction', 'previous');
      const queryString = query.toString();
      const [rules, quarantine] = await Promise.all([
        requestJson<{ senders: Sender[] }>('/api/workspace/blocked-senders', { signal }),
        requestJson<QuarantinePage>(`/api/workspace/quarantine${queryString ? `?${queryString}` : ''}`, { signal })
      ]);
      if (current !== generation || revision !== navigationRevision || !active) return false;
      senders = rules.senders;
      page = quarantine;
      loaded = true;
      void reconcileUncertainReleases(signal, current);
      return true;
    } catch {
      if (current === generation && revision === navigationRevision && active) error = t('blocked.loadFailed');
      return false;
    }
  }

  async function reconcileUncertainReleases(signal: AbortSignal, current: number) {
    for (const id of [...uncertainReleases]) {
      if (signal.aborted || current !== generation || !active) return;
      try {
        const result = await requestJson<{ message: { quarantinedAt?: string | null } }>(
          `/api/workspace/messages/${encodeURIComponent(`email:${id}`)}`, { signal }
        );
        if (signal.aborted || current !== generation || !active) return;
        if (result.message?.quarantinedAt !== null) continue;
        rememberRelease(id, false);
        sync?.publish({ type: 'mailbox-refresh', id: `email:${id}` });
        onRelease?.(id);
      } catch { if (signal.aborted) return; }
    }
  }

  async function navigate(target: PageTarget) {
    if (!active || loading || pending) return;
    refreshRequested = false;
    const current = generation;
    const revision = navigationRevision;
    const location = window.location.href;
    retryTarget = target;
    loading = true;
    try {
      let success = await load(target, revision);
      if (success && target.cursor && !page.items.length && current === generation && revision === navigationRevision && active && window.location.href === location) {
        target = { cursor: null, direction: 'next', number: 1 };
        retryTarget = target;
        success = await load(target, revision);
      }
      if (success && current === generation && revision === navigationRevision && active && window.location.href === location) {
        position = target;
        retryTarget = null;
        const params = new URL(window.location.href).searchParams;
        if ((params.get('quarantineCursor') || null) !== target.cursor ||
          (target.cursor && params.get('quarantinePage') !== String(target.number)) ||
          (params.get('quarantineDirection') || 'next') !== target.direction) {
          await onPageChange?.(target.cursor, target.number, target.direction);
        }
      }
    } catch {
      if (current === generation && revision === navigationRevision && active) { retryTarget = target; error = t('blocked.loadFailed'); }
    } finally {
      if (current === generation) loading = false;
    }
  }

  $effect(() => {
    if (!mounted) return;
    if (!active) { navigationRevision++; refreshRequested = true; return; }
    if (refreshRequested && !loading && !pending) {
      refreshRequested = false;
      untrack(() => { void navigate(error && retryTarget ? retryTarget : positionFromUrl()); });
    }
  });

  async function restoreFocus(source: EventTarget | null, hadFocus: boolean, current: number, preferredId: string) {
    if (!hadFocus) return;
    await tick();
    if (current !== generation || !active || (document.activeElement !== document.body && document.activeElement !== source)) return;
    if (source instanceof HTMLButtonElement && source.isConnected && !source.disabled) {
      source.focus();
      return;
    }
    const preferred = document.getElementById(preferredId);
    if (preferred instanceof HTMLInputElement || preferred instanceof HTMLButtonElement) {
      if (!preferred.disabled) { preferred.focus(); return; }
    }
    document.getElementById('blocked-operation-status')?.focus();
  }

  function beginSessionWrite() {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const channel = createWorkspaceSync((event) => { if (event.type === 'session-ended') cancel(); });
    window.addEventListener(AUTH_EXPIRED_EVENT, cancel);
    window.addEventListener(WORKSPACE_SESSION_ENDED_EVENT, cancel);
    return {
      signal: controller.signal,
      channel,
      close: () => {
        window.removeEventListener(AUTH_EXPIRED_EVENT, cancel);
        window.removeEventListener(WORKSPACE_SESSION_ENDED_EVENT, cancel);
        channel.close();
      }
    };
  }

  async function add(event: SubmitEvent) {
    event.preventDefault();
    if (!active || pending || loading || !loaded) return;
    const current = generation;
    const write = beginSessionWrite();
    pending = true; error = ''; operationError = ''; status = ''; retryTarget = null;
    try {
      const result = await requestJson<{ email: string }>('/api/workspace/blocked-senders', { method: 'POST', body: JSON.stringify({ email }), signal: write.signal });
      write.channel.publish({ type: 'blocked-senders-changed' });
      if (current !== generation) return;
      if (!senders.some((sender) => sender.email === result.email)) senders = [...senders, { email: result.email, createdAt: '' }].sort((a, b) => a.email.localeCompare(b.email));
      email = '';
      status = t('blocked.saved');
    } catch { if (current === generation) operationError = t('blocked.saveFailed'); }
    finally { write.close(); if (current === generation) pending = false; }
  }

  async function remove(address: string, source: EventTarget | null) {
    if (!active || pending || loading) return;
    const hadFocus = document.activeElement === source;
    const current = generation;
    const write = beginSessionWrite();
    pending = true; error = ''; operationError = ''; status = ''; retryTarget = null;
    try {
      await requestJson('/api/workspace/blocked-senders', { method: 'DELETE', body: JSON.stringify({ email: address }), signal: write.signal });
      write.channel.publish({ type: 'blocked-senders-changed' });
      if (current !== generation) return;
      senders = senders.filter((sender) => sender.email !== address);
      status = t('blocked.removed');
    } catch { if (current === generation) operationError = t('blocked.removeFailed'); }
    finally {
      write.close();
      if (current === generation) {
        pending = false;
        await restoreFocus(source, hadFocus, current, 'blocked-sender-email');
      }
    }
  }

  async function release(id: string, source: EventTarget | null) {
    if (!active || pending || loading) return;
    const hadFocus = document.activeElement === source;
    const current = generation;
    const notifyRelease = onRelease;
    const alreadyUncertain = uncertainReleases.has(id);
    rememberRelease(id, true);
    const write = beginSessionWrite();
    pending = true; error = ''; operationError = ''; status = ''; retryTarget = null;
    try {
      let inInbox = true;
      try {
        await requestJson(`/api/workspace/quarantine/${encodeURIComponent(id)}`, { method: 'POST', signal: write.signal });
      } catch (releaseError) {
        if (!write.signal.aborted && releaseError instanceof ClientApiError && releaseError.status >= 400 && releaseError.status < 500 && releaseError.status !== 404) {
          if (!alreadyUncertain) rememberRelease(id, false);
          throw releaseError;
        }
        if (write.signal.aborted) return;
        const result = await requestJson<{ message: { quarantinedAt?: string | null; archivedAt?: string | null } }>(
          `/api/workspace/messages/${encodeURIComponent(`email:${id}`)}`, { signal: write.signal }
        );
        if (result.message?.quarantinedAt !== null) throw releaseError;
        inInbox = result.message.archivedAt === null;
      }
      rememberRelease(id, false);
      write.channel.publish({ type: 'mailbox-refresh', id: `email:${id}` });
      write.channel.publish({ type: 'blocked-senders-changed' });
      notifyRelease?.(id);
      if (current !== generation) return;
      page = { ...page, items: page.items.filter((item) => item.id !== id) };
      if (inInbox) status = t('blocked.released');
      else operationError = t('blocked.releaseFailed');
      if (!page.items.length) refreshRequested = true;
    } catch { if (current === generation) operationError = t('blocked.releaseFailed'); }
    finally {
      write.close();
      if (current === generation) {
        pending = false;
        await restoreFocus(source, hadFocus, current, 'blocked-quarantine-refresh');
      }
    }
  }

  function messageHref(id: string) {
    const params = new URLSearchParams({ folder: 'settings', tab: 'blocked' });
    if (position.cursor) {
      params.set('quarantineCursor', position.cursor);
      params.set('quarantinePage', String(position.number));
      if (position.direction === 'previous') params.set('quarantineDirection', 'previous');
    }
    return `/messages/${encodeURIComponent(`email:${id}`)}?${params.toString()}`;
  }

</script>

<div class="blocked-layout">
  <Panel title={t('blocked.title')} description={t('blocked.description')}>
    <form class="add-row" onsubmit={add}>
      <TextField id="blocked-sender-email" type="email" label={t('blocked.email')} bind:value={email} maxlength={254} required disabled={!active || pending || loading || !loaded} />
      <Button type="submit" disabled={!active || pending || loading || !loaded}>{t('blocked.add')}</Button>
    </form>
    <p class="note">{t('blocked.warning')}</p>
    {#if loaded && senders.length === 0}<p class="note">{t('blocked.empty')}</p>{/if}
    <ul class="entries">
      {#each senders as sender (sender.email)}
        <li><span>{sender.email}</span><Button variant="secondary" disabled={!active || pending || loading} ariaLabel={`${t('blocked.remove')} ${sender.email}`} onclick={(event) => remove(sender.email, event.currentTarget)}>{t('blocked.remove')}</Button></li>
      {/each}
    </ul>
  </Panel>
  <Panel title={t('blocked.quarantine')} description={t('blocked.quarantineDescription')}>
    <Button id="blocked-quarantine-refresh" variant="secondary" disabled={!active || loading || pending} onclick={() => navigate({ cursor: null, direction: 'next', number: 1 })}>{t('blocked.refresh')}</Button>
    {#if loaded && page.items.length === 0}<p class="note">{t('blocked.quarantineEmpty')}</p>{/if}
    <ul class="entries">
      {#each page.items as item (item.id)}
        <li>
          <div class="message"><a href={messageHref(item.id)}>{item.subject || t('blocked.noSubject')}</a><span>{item.sender}</span></div>
          <Button variant="secondary" disabled={!active || pending || loading} ariaLabel={`${t('blocked.release')} ${item.subject}`} onclick={(event) => release(item.id, event.currentTarget)}>{t('blocked.release')}</Button>
        </li>
      {/each}
    </ul>
    <div class="paging">
      <Button variant="secondary" disabled={!active || loading || pending || !page.previousCursor} onclick={() => navigate(position.number <= 2 ? { cursor: null, direction: 'next', number: 1 } : { cursor: page.previousCursor, direction: 'previous', number: position.number - 1 })}>{t('blocked.previous')}</Button>
      <span>{position.number}</span>
      <Button variant="secondary" disabled={!active || loading || pending || !page.nextCursor} onclick={() => navigate({ cursor: page.nextCursor, direction: 'next', number: position.number + 1 })}>{t('blocked.next')}</Button>
    </div>
  </Panel>
  {#if error || operationError}<p role="alert">{error || operationError} {#if error && retryTarget}<button type="button" disabled={!active} onclick={() => retryTarget && navigate(retryTarget)}>{t('blocked.retry')}</button>{/if}</p>{/if}
  {#if status}<p id="blocked-operation-status" role="status" aria-live="polite" tabindex="-1">{status}</p>{/if}
</div>

<style>
  .blocked-layout { display: grid; gap: var(--space-5); }
  .add-row { display: flex; gap: var(--space-3); align-items: end; flex-wrap: wrap; }
  .add-row :global(label) { flex: 1 1 15rem; min-width: 0; }
  .note { margin: var(--space-3) 0 0; color: var(--fm-text-muted); font-size: 12px; }
  .entries { list-style: none; margin: var(--space-3) 0 0; padding: 0; }
  .entries li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) 0; border-top: 1px solid var(--fm-border); }
  .entries span, .message a { overflow-wrap: anywhere; }
  .message { display: grid; min-width: 0; gap: var(--space-1); }
  .message span { color: var(--fm-text-muted); font-size: 12px; }
  .message a, [role='alert'] button { color: var(--fm-primary); text-decoration: underline; }
  .paging { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); margin-top: var(--space-3); }
</style>
