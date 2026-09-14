<script lang="ts">
  import LockKeyhole from '@lucide/svelte/icons/lock-keyhole';
  import BrandMark from '$lib/components/shell/BrandMark.svelte';
  import Banner from '$lib/components/ui/Banner.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import TextField from '$lib/components/ui/TextField.svelte';
  import type { LoginInput } from '$lib/domain/mail';
  import LanguageSwitcher from '$lib/components/shell/LanguageSwitcher.svelte';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    loginError = '',
    pending = false,
    onLogin
  }: {
    runtimeLabel: string;
    dbBound: boolean;
    bucketBound: boolean;
    loginError?: string;
    pending?: boolean;
    onLogin: (payload: LoginInput) => void | Promise<void>;
  } = $props();

  let email = $state('');
  let password = $state('');
  const { t } = useLocale();

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    await onLogin({ email, password, remember: true });
  }
</script>

<main class="login-canvas">
  <section class="login-panel" aria-labelledby="login-title">
    <div class="brand-row"><BrandMark /><LanguageSwitcher /></div>
    <div class="intro">
      <h1 id="login-title">{t('auth.loginTitle')}</h1>
      <p>{t('auth.loginIntro')}</p>
    </div>

    <form onsubmit={submit}>
      <TextField
        id="login-email"
        name="email"
        type="email"
        label={t('auth.email')}
        value={email}
        autocomplete="username"
        placeholder="name@example.com"
        required
        disabled={pending}
        oninput={(event) => (email = event.currentTarget.value)}
      />
      <TextField
        id="login-password"
        name="password"
        type="password"
        label={t('auth.password')}
        value={password}
        autocomplete="current-password"
        placeholder={t('auth.passwordPlaceholder')}
        required
        disabled={pending}
        oninput={(event) => (password = event.currentTarget.value)}
      />

      {#if loginError}
        <Banner variant="danger" title={t('auth.loginFailed')}>{loginError}</Banner>
      {/if}

      <Button type="submit" loading={pending} class="w-full">
        {pending ? t('auth.verifying') : t('auth.login')}
      </Button>
    </form>

    <footer>
      <LockKeyhole size={15} strokeWidth={1.8} aria-hidden="true" />
      <span>{t('auth.cookieSecurity')}</span>
    </footer>
  </section>
</main>

<style>
  .login-canvas {
    display: grid;
    min-height: 100dvh;
    place-items: center;
    padding: var(--space-6);
    background: var(--fm-canvas);
  }

  .login-panel {
    width: min(100%, 400px);
    overflow: hidden;
    border: 1px solid var(--fm-border);
    border-radius: var(--radius-lg);
    background: var(--fm-surface);
  }

  .brand-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-5) var(--space-6);
    border-bottom: 1px solid var(--fm-border);
  }

  .intro {
    padding: var(--space-6) var(--space-6) 0;
  }

  h1 {
    margin: 0;
    color: var(--fm-text);
    font-size: 22px;
    font-weight: 650;
    letter-spacing: -0.025em;
  }

  .intro p {
    margin: var(--space-2) 0 0;
    color: var(--fm-text-muted);
    font-size: 13px;
  }

  form {
    display: grid;
    gap: var(--space-4);
    padding: var(--space-6);
  }

  footer {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-6);
    border-top: 1px solid var(--fm-border);
    color: var(--fm-text-muted);
    background: var(--fm-surface-subtle);
    font-size: 12px;
  }

  @media (max-width: 480px) {
    .login-canvas {
      align-items: stretch;
      padding: 0;
      background: var(--fm-surface);
    }

    .login-panel {
      width: 100%;
      border: 0;
      border-radius: 0;
    }
  }
</style>
