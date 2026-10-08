<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import TextField from '$lib/components/ui/TextField.svelte';
  import { requestJson } from '$lib/client/api';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let { available, workerName, onCreated, onRefresh }: {
    available: boolean; workerName: string | null; onCreated: (domainId: string) => Promise<void>;
    onRefresh: () => Promise<void>;
  } = $props();
  const { t } = useLocale();
  let domainName = $state('');
  let zoneId = $state('');
  let pending = $state(false);
  let errorMessage = $state('');

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (pending || !available) return;
    pending = true;
    errorMessage = '';
    try {
      const result = await requestJson<{ domain: { id: string } }>('/api/workspace/mail-identities/domains', {
        method: 'POST', body: JSON.stringify({ domainName, zoneId })
      });
      domainName = '';
      zoneId = '';
      await onCreated(result.domain.id);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : t('settings.mailIdentityActionFailed');
    } finally { pending = false; }
  }
</script>

<form class="domain-setup" onsubmit={submit} aria-label={t('settings.addMailDomain')}>
  <strong>{t('settings.addMailDomain')}</strong>
  <p>{t('settings.domainSetupDescription')}</p>
  {#if !available}
    <p class="configuration-notice" role="status">{t(workerName ? 'settings.domainReadPermissionMissing' : 'settings.domainWorkerMissing')}</p>
    <Button variant="secondary" onclick={() => void onRefresh()}>{t('settings.refreshDomainConfiguration')}</Button>
  {/if}
  <div class="fields">
    <TextField id="new-mail-domain" label={t('settings.domainName')} value={domainName} placeholder="example.com" required maxlength={253} disabled={pending || !available} oninput={(event) => domainName = event.currentTarget.value} />
    <TextField id="new-mail-zone" label={t('settings.domainZoneId')} value={zoneId} placeholder={t('settings.domainZonePlaceholder')} required maxlength={32} disabled={pending || !available} oninput={(event) => zoneId = event.currentTarget.value} />
  </div>
  <p>{t('settings.domainZoneHelp')}</p>
  {#if errorMessage}<p class="error" role="alert">{errorMessage}</p>{/if}
  <Button type="submit" loading={pending} disabled={!available || !domainName.trim() || !zoneId.trim()}>{t('settings.connectMailDomain')}</Button>
</form>

<style>
  .domain-setup { display: grid; gap: 0.75rem; padding: 1rem; border: 1px solid var(--fm-border); border-radius: 0.75rem; }
  .fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
  p { margin: 0; font-size: 0.8rem; line-height: 1.6; color: var(--fm-text-muted); overflow-wrap: anywhere; }
  .configuration-notice { color: var(--fm-text); }
  .error { color: var(--fm-danger); }
  @media (max-width: 640px) { .fields { grid-template-columns: minmax(0, 1fr); } }
</style>
