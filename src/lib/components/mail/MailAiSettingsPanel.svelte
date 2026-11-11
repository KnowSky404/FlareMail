<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Button, Panel, Select, Switch, TextField } from '$lib/components/ui';
  import { ClientApiError, requestJson } from '$lib/client/api';
  import type { MailAiSettings, MailAiSettingsView } from '$lib/domain/mail/ai';
  import { useLocale } from '$lib/i18n/runtime.svelte';
  const { t } = useLocale();
  let response = $state<MailAiSettingsView | null>(null);
  let settings = $state<MailAiSettings>({ enabled: false, apiFormat: 'chat-completions', baseUrl: '', model: '', timeoutMs: 15000, maxInputChars: 16000 });
  let apiKey = $state('');
  let clearApiKey = $state(false);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let saved = $state(false);
  const controller = new AbortController();
  const path = '/api/workspace/ai/settings';
  function showError(cause: unknown) { return t('aiSettings.error', { code: cause instanceof ClientApiError ? cause.code : 'NETWORK_FAILURE' }); }
  async function load() {
    if (loading || saving) return;
    loading = true; error = ''; saved = false;
    try {
      response = await requestJson<MailAiSettingsView>(path, { signal: controller.signal });
      settings = { ...response.settings }; apiKey = ''; clearApiKey = false;
    } catch (cause) { if (!controller.signal.aborted) error = showError(cause); }
    finally { loading = false; }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!response?.canSave || loading || saving) return;
    saving = true; error = ''; saved = false;
    // Retain the submitted key only for this request; never keep a saved key in the form.
    const key = apiKey; apiKey = '';
    try {
      response = await requestJson<MailAiSettingsView>(path, { method: 'PATCH', signal: controller.signal, body: JSON.stringify({ ...settings, revision: response.revision,
        ...(key ? { apiKey: key } : {}), clearApiKey }) });
      settings = { ...response.settings }; clearApiKey = false; saved = true;
    } catch (cause) { if (!controller.signal.aborted) error = showError(cause); }
    finally { saving = false; }
  }
  onMount(() => { void load(); });
  onDestroy(() => { controller.abort(); apiKey = ''; });
</script>

<Panel title={t('aiSettings.title')} description={t('aiSettings.description')}>
  <div class="space-y-4 min-w-0">
    {#if loading}<p role="status">{t('common.loading')}</p>{/if}
    {#if error}<p role="alert" class="text-sm text-[var(--fm-danger)] [overflow-wrap:anywhere]">{error}</p>{/if}
    {#if response}
      <p class="text-xs text-[var(--fm-text-muted)]">{t('aiSettings.privacy')}</p>
      {#if !response.canSave}<p role="status" class="text-sm">{t('aiSettings.unavailable')}</p>{/if}
      <form class="space-y-4" onsubmit={save}>
        <Switch id="ai-settings-enabled" label={t('aiSettings.enabled')} checked={settings.enabled} disabled={!response.canSave || saving} onchange={(checked) => settings.enabled = checked} />
        <div class="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField id="ai-settings-base" label={t('aiSettings.baseUrl')} type="url" value={settings.baseUrl} placeholder="https://api.openai.com/v1" maxlength={2048} disabled={saving || !response.canSave} hint={t('aiSettings.endpointHint')} oninput={(event) => settings.baseUrl = event.currentTarget.value} />
          <TextField id="ai-settings-model" label={t('aiSettings.model')} value={settings.model} maxlength={128} disabled={saving || !response.canSave} oninput={(event) => settings.model = event.currentTarget.value} />
          <Select id="ai-settings-format" label={t('aiSettings.format')} value={settings.apiFormat} options={[{value: 'chat-completions', label: 'Chat Completions'}, {value: 'responses', label: 'Responses API'}]} disabled={saving || !response.canSave} onchange={(value) => settings.apiFormat = value as MailAiSettings['apiFormat']} />
          <TextField id="ai-settings-key" label="API Key" type="password" autocomplete="new-password" value={apiKey} maxlength={4096} disabled={saving || clearApiKey || !response.canSave} hint={response.hasApiKey ? t('aiSettings.keySaved') : t('aiSettings.keyMissing')} oninput={(event) => apiKey = event.currentTarget.value} />
          <TextField id="ai-settings-timeout" label={t('aiSettings.timeout')} type="number" value={String(settings.timeoutMs)} disabled={saving || !response.canSave} hint="100–30000 ms" oninput={(event) => settings.timeoutMs = Number(event.currentTarget.value)} />
          <TextField id="ai-settings-limit" label={t('aiSettings.inputLimit')} type="number" value={String(settings.maxInputChars)} disabled={saving || !response.canSave} hint="256–32000" oninput={(event) => settings.maxInputChars = Number(event.currentTarget.value)} />
        </div>
        <Switch id="ai-settings-clear-key" label={t('aiSettings.clearKey')} checked={clearApiKey} disabled={saving || !response.canSave} onchange={(checked) => { clearApiKey = checked; if (checked) apiKey = ''; }} />
        <div class="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={saving} disabled={loading || !response.canSave}>{t('common.save')}</Button>
          <Button variant="secondary" disabled={saving || loading} onclick={() => void load()}>{t('aiSettings.reload')}</Button>
          {#if saved}<p role="status" class="text-sm text-[var(--fm-success)]">{t('aiSettings.saved')}</p>{/if}
        </div>
      </form>
    {:else if !loading}<Button variant="secondary" onclick={() => void load()}>{t('aiSettings.reload')}</Button>{/if}
  </div>
</Panel>
