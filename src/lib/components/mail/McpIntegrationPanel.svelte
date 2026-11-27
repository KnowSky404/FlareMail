<script lang="ts">
  import { onMount } from 'svelte';
  import { Check, Copy, RefreshCw } from '@lucide/svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Badge from '$lib/components/ui/Badge.svelte';
  import Banner from '$lib/components/ui/Banner.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
  import { requestJson } from '$lib/client/api';
  import { mcpScopes, type McpScope } from '$lib/domain/mail/mcp';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  type Client = {
    id: string; clientId: string; name: string; scopes: McpScope[];
    authorizedAt: number; expiresAt: number; lastUsedAt: number | null;
    status: 'active' | 'pending' | 'revoked' | 'expired';
  };
  type Activity = {
    id: string; client: string; tool: string; durationMs: number; time: number;
    outcome: 'ok' | 'denied' | 'invalid_input' | 'not_found' | 'limited' | 'unavailable';
  };
  type Cursor = { time: number; id: string };
  type Summary = {
    enabled: boolean; status: 'disabled' | 'enabled' | 'incomplete' | 'unavailable'; endpoint: string | null;
    scopes: McpScope[]; activeCount: number; clients: Client[];
    activity: { items: Activity[]; next: Cursor | null };
  };
  type Mutation = { action: 'settings'; enabled: boolean; scopes: McpScope[] } |
    { action: 'revoke'; id: string } | { action: 'revoke-all' };

  const locale = useLocale();
  const { t } = locale;
  const endpoint = '/api/workspace/integrations/mcp';
  let summary = $state<Summary | null>(null);
  let enabled = $state(false);
  let scopes = $state<McpScope[]>([]);
  let pending = $state(false);
  let loading = $state(false);
  let error = $state<'loadFailed' | 'saveFailed' | 'copyFailed' | null>(null);
  let copied = $state(false);
  let confirm = $state<Mutation | null>(null);
  let abort: AbortController | undefined;
  const canRevoke = (client: Client) => client.status === 'active' || client.status === 'pending';
  const dirty = $derived(summary && (enabled !== summary.enabled || scopes.join() !== summary.scopes.join()));

  onMount(() => {
    abort = new AbortController();
    void load();
    return () => abort?.abort();
  });

  function badgeClass(tone: 'success' | 'warning' | 'neutral') {
    return tone === 'success' ? 'bg-fm-success-soft text-fm-success'
      : tone === 'warning' ? 'bg-fm-warning-soft text-fm-warning' : '';
  }

  function formatTime(seconds: number | null) {
    return seconds ? new Intl.DateTimeFormat(locale.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(seconds * 1000) : '—';
  }

  async function load(cursor?: Cursor | null) {
    loading = true;
    error = null;
    try {
      const search = cursor ? '?' + new URLSearchParams({ time: String(cursor.time), id: cursor.id }) : '';
      const result = await requestJson<Summary>(endpoint + search, { signal: abort?.signal });
      if (cursor && summary) {
        summary.activity = { ...result.activity, items: [...summary.activity.items, ...result.activity.items] };
      } else {
        summary = result;
        enabled = result.enabled;
        scopes = result.scopes;
      }
    } catch {
      if (!abort?.signal.aborted) error = 'loadFailed';
    } finally {
      loading = false;
    }
  }

  async function mutate(input: Mutation) {
    pending = true;
    error = null;
    try {
      await requestJson(endpoint, { method: 'POST', body: JSON.stringify(input), signal: abort?.signal });
      confirm = null;
      await load();
    } catch {
      if (!abort?.signal.aborted) {
        confirm = null;
        error = 'saveFailed';
      }
    } finally {
      pending = false;
    }
  }

  function save(event: SubmitEvent) {
    event.preventDefault();
    const input = { action: 'settings' as const, enabled, scopes };
    if (summary?.enabled && !enabled) confirm = input;
    else void mutate(input);
  }

  async function copyAddress() {
    if (!summary?.endpoint) return;
    try {
      await navigator.clipboard.writeText(summary.endpoint);
      copied = true;
      error = null;
    } catch {
      error = 'copyFailed';
    }
  }
</script>

<div class="integration" aria-busy={loading || pending}>
  {#if error}<Banner variant="danger" title={t(`mcp.${error}`)} />{/if}
  <Panel title={t('mcp.server')}>
    {#snippet header()}
      <IconButton ariaLabel={t('mcp.refresh')} onclick={() => load()} disabled={loading || pending}><RefreshCw size={16} /></IconButton>
    {/snippet}
    {#if summary}
      <div class="status">
        <Badge class={badgeClass(summary.status === 'enabled' ? 'success' : summary.status === 'disabled' ? 'neutral' : 'warning')}>
          {t(`mcp.${summary.status}`)}
        </Badge>
        <span>{t('mcp.transport')} · {t('mcp.auth')}</span>
        <span>{t('mcp.activeCount', { count: summary.activeCount })}</span>
      </div>
      {#if summary.status === 'incomplete'}
        <p class="muted">{t('mcp.configuration')}</p>
      {/if}
      {#if summary.endpoint}
        <div class="endpoint">
          <div><span class="muted">{t('mcp.endpoint')}</span><code>{summary.endpoint}</code></div>
          <IconButton ariaLabel={t('mcp.copy')} onclick={copyAddress}>
            {#if copied}<Check size={16} />{:else}<Copy size={16} />{/if}
          </IconButton>
          <span class="sr-only" aria-live="polite">{copied ? t('mcp.copied') : ''}</span>
        </div>
      {/if}
      <form onsubmit={save}>
        <Switch id="mcp-enabled" label={t('mcp.enable')} checked={enabled}
          disabled={pending || (!enabled && ['incomplete', 'unavailable'].includes(summary.status))}
          onchange={(value) => enabled = value} />
        <fieldset>
          <legend>{t('mcp.policy')}</legend>
          <p class="muted">{t('mcp.policyDetail')}</p>
          {#each mcpScopes as scope (scope)}
            <label><input type="checkbox" value={scope} bind:group={scopes} disabled={pending} />
              {t(`mcp.scope.${scope}`)}
            </label>
          {/each}
        </fieldset>
        <Button type="submit" disabled={!dirty || loading || (enabled && ['incomplete', 'unavailable'].includes(summary.status))}
          loading={pending && !confirm}>{t('settings.save')}</Button>
      </form>
    {:else if loading}
      <p role="status">{t('common.loading')}</p>
    {/if}
  </Panel>

  {#if summary}
    <Panel title={t('mcp.clients')}>
      {#snippet header()}
        <Button variant="secondary" size="sm" disabled={!summary?.clients.some(canRevoke) || pending} onclick={() => confirm = { action: 'revoke-all' }}>
          {t('mcp.revokeAll')}
        </Button>
      {/snippet}
      {#if !summary.clients.length}<p class="muted">{t('mcp.noClients')}</p>{/if}
      <ul class="rows">
        {#each summary.clients as client (client.id)}
          <li>
            <details>
              <summary><strong>{client.name}</strong> <code>{client.clientId}</code>
                <Badge class={badgeClass(client.status === 'active' ? 'success' : 'neutral')}>{t(`mcp.${client.status}`)}</Badge>
              </summary>
              <dl>
                <dt>{t('mcp.authorizedAt')}</dt><dd>{formatTime(client.authorizedAt)}</dd>
                <dt>{t('mcp.lastUsed')}</dt><dd>{formatTime(client.lastUsedAt)}</dd>
                <dt>{t('mcp.expires')}</dt><dd>{formatTime(client.expiresAt)}</dd>
                <dt>{t('mcp.policy')}</dt><dd>{client.scopes.map((scope) => t(`mcp.scope.${scope}`)).join(' · ') || '—'}</dd>
              </dl>
            </details>
            {#if canRevoke(client)}
              <Button variant="ghost" size="sm" disabled={pending} onclick={() => confirm = { action: 'revoke', id: client.id }}>{t('mcp.revoke')}</Button>
            {/if}
          </li>
        {/each}
      </ul>
    </Panel>
    <Panel title={t('mcp.activity')}>
      {#if !summary.activity.items.length}<p class="muted">{t('mcp.noActivity')}</p>{/if}
      <ul class="rows">
        {#each summary.activity.items as entry (entry.id)}
          <li>
            <details>
              <summary><code>{entry.tool}</code> <span>{entry.client}</span>
                <Badge class={badgeClass(entry.outcome === 'ok' ? 'success' : 'warning')}>{t(`mcp.outcome.${entry.outcome}`)}</Badge>
              </summary>
              <dl>
                <dt>{t('mcp.requestId')}</dt><dd><code>{entry.id}</code></dd>
              </dl>
            </details>
            <span class="muted">{formatTime(entry.time)} · {entry.durationMs} ms</span>
          </li>
        {/each}
      </ul>
      {#if summary.activity.next}
        <Button variant="secondary" size="sm" disabled={loading || pending} onclick={() => load(summary?.activity.next)}>{t('mcp.more')}</Button>
      {/if}
    </Panel>
    <Panel title={t('mcp.connect')}>
      <p>{t('mcp.connectInstructions')}</p>
      <a href="https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt" target="_blank" rel="noopener noreferrer">{t('mcp.officialGuide')}</a>
    </Panel>
  {/if}
</div>

<ConfirmDialog open={confirm !== null} pending={pending}
  title={t(confirm?.action === 'settings' ? 'mcp.disabled' : confirm?.action === 'revoke-all' ? 'mcp.revokeAll' : 'mcp.revoke')}
  description={t(confirm?.action === 'settings' ? 'mcp.disableDetail' : confirm?.action === 'revoke-all' ? 'mcp.revokeAllDetail' : 'mcp.revokeOneDetail')}
  onConfirm={() => { if (confirm) return mutate(confirm); }} onCancel={() => { if (!pending) confirm = null; }} />

<style>
  .integration, form { display: grid; gap: 1rem; min-width: 0; }
  form { justify-items: start; margin-top: .75rem; }
  fieldset { min-width: 0; }
  legend { font-weight: 600; }
  .status, .endpoint { display: flex; gap: .65rem; align-items: center; flex-wrap: wrap; }
  .endpoint { margin-top: .75rem; justify-content: space-between; }
  .endpoint > div { display: grid; gap: .2rem; min-width: 0; }
  .muted { color: var(--fm-text-muted); font-size: .8125rem; }
  label { display: flex; gap: .5rem; align-items: center; min-height: 2rem; cursor: pointer; }
  input { accent-color: var(--fm-primary); }
  code, summary, dd { overflow-wrap: anywhere; }
  summary { cursor: pointer; }
  .rows { margin: 0; }
  .rows li { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: .5rem 1rem; padding: .65rem 0; }
  .rows li + li { border-top: 1px solid var(--fm-border); }
  details { min-width: 0; }
  dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .2rem .6rem; margin-top: .5rem; font-size: .8125rem; }
  dt { color: var(--fm-text-muted); }
  a { color: var(--fm-primary); text-decoration: underline; }
</style>
