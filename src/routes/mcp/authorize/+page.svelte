<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageData, ActionData } from './$types';
  import LoginView from '$lib/components/mail/LoginView.svelte';
  import BrandMark from '$lib/components/shell/BrandMark.svelte';
  import LanguageSwitcher from '$lib/components/shell/LanguageSwitcher.svelte';
  import Banner from '$lib/components/ui/Banner.svelte';
  import { buttonClass } from '$lib/components/ui/styles';
  import Panel from '$lib/components/ui/Panel.svelte';
  import { useLocale } from '$lib/i18n/runtime.svelte';
  import { createSession } from '$lib/client/workspace-api';
  import { clearClientAuthExpired } from '$lib/client/auth-session';
  import type { LoginInput } from '$lib/domain/mail';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  const { t } = useLocale();
  let pending = $state(false);
  let loginError = $state('');

  async function login(input: LoginInput) {
    pending = true;
    loginError = '';
    try {
      await createSession(input);
      clearClientAuthExpired();
      location.reload();
    } catch {
      loginError = t('auth.loginFailed');
    } finally {
      pending = false;
    }
  }
</script>

<svelte:head>
  <title>{t('mcp.consent')} · FlareMail</title>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

{#if data.status === 'login'}
  <LoginView runtimeLabel="FlareMail" dbBound bucketBound authConfigured={data.authConfigured} {pending} {loginError} onLogin={login} />
{:else}
  <main class="consent">
    <div class="content">
      <div class="brand"><BrandMark /><LanguageSwitcher /></div>
      <h1>{t('mcp.consent')}</h1>
      {#if form?.reason || data.status !== 'consent'}
        <Banner variant="warning" title={t('mcp.unavailable')}>
          {t(form?.reason === 'invalid' || data.status === 'invalid' ? 'mcp.invalidConsent' : 'mcp.consentUnavailable')}
        </Banner>
      {/if}
      {#if data.status === 'consent'}
        <Panel>
          <p>{t('mcp.consentIntro', { client: data.clientName })}</p>
          <dl><dt>{t('mcp.redirectHost')}</dt><dd>{data.redirectHost}</dd></dl>
          {#if data.redirectIsLoopback}<p class="muted">{t('mcp.loopback')}</p>{/if}
          <form method="POST" use:enhance={() => async ({ result, update }) => {
            if (result.type === 'redirect') location.assign(result.location);
            else await update();
          }}>
            <input type="hidden" name="handle" value={data.handle} />
            <fieldset>
              <legend>{t('mcp.policy')}</legend>
              {#each data.scopes as scope (scope)}
                <label><input type="checkbox" name="scope" value={scope} checked={scope !== 'mail.attachments.metadata.read'} />
                  <span>{t(`mcp.scope.${scope}`)}</span>
                </label>
              {/each}
            </fieldset>
            <p class="muted">{t('mcp.consentDetails')}</p>
            <div class="actions">
              <button class={buttonClass('secondary', 'md')} type="submit" name="decision" value="deny">{t('mcp.deny')}</button>
              <button class={buttonClass('primary', 'md')} type="submit" name="decision" value="approve">{t('mcp.approve')}</button>
            </div>
          </form>
        </Panel>
      {:else}
        <a href="/?folder=settings&tab=integrations" class={buttonClass('secondary', 'md')}>{t('mcp.title')}</a>
      {/if}
    </div>
  </main>
{/if}

<style>
  .consent { min-height: 100dvh; display: grid; place-items: start center; padding: var(--space-6); background: var(--fm-canvas); }
  .content { width: min(100%, 30rem); display: grid; gap: var(--space-4); margin-block: clamp(0rem, 10vh, 5rem); }
  .brand, .actions { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; }
  .actions { justify-content: flex-end; }
  h1 { margin: 0; font-size: 1.5rem; font-weight: 650; }
  form, fieldset { display: grid; gap: .75rem; margin-top: 1rem; min-width: 0; }
  legend { font-weight: 600; margin-bottom: .5rem; }
  label { display: flex; align-items: center; gap: .5rem; min-height: 2rem; cursor: pointer; }
  input { accent-color: var(--fm-primary); }
  dl { margin-block: .6rem; display: flex; gap: .5rem; flex-wrap: wrap; }
  dt, .muted { color: var(--fm-text-muted); }
  p, dd { overflow-wrap: anywhere; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--fm-primary); outline-offset: 2px; }
</style>
