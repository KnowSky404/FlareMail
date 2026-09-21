<script lang="ts">
  import { onMount } from 'svelte';
  import type { PageData } from './$types';
  import type { DeliveryDetail, InboundMessageDetail, MailAttachmentSummary, MailMessage } from '$lib/domain/mail';
  import MessageDetail from '$lib/components/mail/MessageDetail.svelte';
  import AuthExpiredNotice from '$lib/components/mail/AuthExpiredNotice.svelte';
  import LanguageSwitcher from '$lib/components/shell/LanguageSwitcher.svelte';
  import { ClientApiError } from '$lib/client/api';
  import {
    fetchDeliveryDetail,
    fetchInboundDetail,
    fetchMessageBody,
    fetchWorkspaceMessage,
    fetchWorkspaceSession,
    updateMessageFlags
  } from '$lib/client/workspace-api';
  import {
    AUTH_EXPIRED_EVENT,
    clearClientAuthExpired,
    createAuthSessionChannel,
    isClientAuthExpired,
    markClientAuthExpired,
    openReauthenticationTab,
    type AuthExpirySource
  } from '$lib/client/auth-session';
  import { createWorkspaceSync } from '$lib/client/workspace-sync';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let { data }: { data: PageData } = $props();
  const i18n = useLocale();
  const { t } = i18n;
  let messageOverride = $state<MailMessage | null>(null);
  const message = $derived(messageOverride ?? data.message);

  let inboundDetail = $state<InboundMessageDetail | null>(null);
  let inboundDetailError = $state('');
  let inboundDetailPending = $state(false);
  let workspaceBody = $state<string | null>(null);
  let workspaceAttachments = $state<MailAttachmentSummary[]>([]);
  let workspaceBodyError = $state('');
  let workspaceBodyPending = $state(false);
  let deliveryDetail = $state<DeliveryDetail | null>(null);
  let deliveryDetailError = $state('');
  let deliveryDetailPending = $state(false);
  let mutationPending = $state(false);
  let mutationError = $state('');
  let authExpired = $state(false);
  let authRecoveryPending = $state(false);
  let authRecoveryError = $state('');
  let authSessionSync: ReturnType<typeof createAuthSessionChannel> | null = null;
  let activeController: AbortController | null = null;
  let mounted = false;
  let authRecoveryPromise: Promise<boolean> | null = null;
  let pending = $derived(authExpired || inboundDetailPending || workspaceBodyPending || deliveryDetailPending || mutationPending);

  const errorMessage = (value: unknown, fallback: string) =>
    value instanceof ClientApiError && i18n.locale === 'en'
      ? fallback
      : value instanceof Error
        ? value.message
        : fallback;

  async function updateFlags(patch: { read?: boolean; starred?: boolean }) {
    mutationPending = true;
    mutationError = '';
    try {
      const result = await updateMessageFlags(message.id, patch);
      messageOverride = result.message;
      sync?.publish({ type: 'message-updated', id: result.message.id });
    } catch (error) {
      mutationError = errorMessage(error, t('mail.flagUpdateError'));
    } finally {
      mutationPending = false;
    }
  }

  let sync: ReturnType<typeof createWorkspaceSync> | null = null;

  async function refreshMessageFromWorkspace() {
    try {
      const result = await fetchWorkspaceMessage(message.id);
      messageOverride = result.message;
    } catch (error) {
      if (error instanceof ClientApiError && error.code === 'AUTH_SESSION_EXPIRED') return;
      if (error instanceof ClientApiError && [401, 403, 404].includes(error.status)) {
        window.location.assign(data.backHref);
      }
    }
  }

  function enterAuthExpired(source: AuthExpirySource) {
    if (authExpired) return;
    authExpired = true;
    authRecoveryError = '';
    activeController?.abort();
    activeController = null;
    if (source !== 'other-tab') authSessionSync?.publish({ type: 'expired' });
  }

  async function reloadReaderContent(signal: AbortSignal) {
    const fresh = await fetchWorkspaceMessage(message.id, signal);
    if (signal.aborted || !mounted) return;
    messageOverride = fresh.message;

    if (fresh.message.source === 'inbound') {
      inboundDetailPending = true;
      try {
        const result = await fetchInboundDetail(fresh.message.id, signal);
        if (!signal.aborted && mounted) {
          inboundDetail = result.detail;
          inboundDetailError = '';
        }
      } finally {
        if (!signal.aborted && mounted) inboundDetailPending = false;
      }
      return;
    }

    workspaceBodyPending = true;
    try {
      const result = await fetchMessageBody(fresh.message.id, signal);
      if (!signal.aborted && mounted) {
        workspaceBody = result.body;
        workspaceAttachments = result.attachments;
        workspaceBodyError = '';
      }
    } finally {
      if (!signal.aborted && mounted) workspaceBodyPending = false;
    }

    if (fresh.message.folder === 'sent') {
      deliveryDetailPending = true;
      try {
        const result = await fetchDeliveryDetail(fresh.message.id, signal);
        if (!signal.aborted && mounted) {
          deliveryDetail = result.detail;
          deliveryDetailError = '';
        }
      } finally {
        if (!signal.aborted && mounted) deliveryDetailPending = false;
      }
    }
  }

  async function recoverExpiredSession(): Promise<boolean> {
    if (!authExpired) return true;
    if (authRecoveryPromise) return authRecoveryPromise;
    authRecoveryPending = true;
    authRecoveryError = '';
    const operation = (async () => {
      try {
        const result = await fetchWorkspaceSession({ allowAfterAuthExpiry: true });
        if (!result.authenticated || !result.workspace) {
          authRecoveryError = t('auth.sessionNotRestored');
          return false;
        }
        clearClientAuthExpired();
        authExpired = false;
        authSessionSync?.publish({ type: 'authenticated' });
        const controller = new AbortController();
        activeController = controller;
        await reloadReaderContent(controller.signal);
        return !controller.signal.aborted;
      } catch (error) {
        authRecoveryError = errorMessage(error, t('auth.recoveryFailed'));
        return false;
      } finally {
        authRecoveryPending = false;
      }
    })();
    authRecoveryPromise = operation;
    try {
      return await operation;
    } finally {
      if (authRecoveryPromise === operation) authRecoveryPromise = null;
    }
  }

  function returnToWorkspace(action?: 'reply' | 'forward') {
    const target = new URL(data.backHref, window.location.origin);
    if (action) target.searchParams.set('compose', action);
    window.location.assign(`${target.pathname}${target.search}`);
  }

  onMount(() => {
    mounted = true;
    const controller = new AbortController();
    activeController = controller;
    authSessionSync = createAuthSessionChannel((message) => {
      if (message.type === 'expired') markClientAuthExpired('other-tab');
      else if (authExpired) void recoverExpiredSession();
    });
    const handleAuthExpired = (event: Event) => {
      const source = (event as CustomEvent<{ source?: AuthExpirySource }>).detail?.source;
      enterAuthExpired(source ?? 'worker-session');
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    if (isClientAuthExpired()) enterAuthExpired('worker-session');
    else authSessionSync.publish({ type: 'authenticated' });

    sync = createWorkspaceSync((event) => {
      if (event.type === 'session-ended') {
        window.location.assign(data.backHref);
        return;
      }
      if (event.type === 'mail-identity-options-changed') return;
      if (event.id === message.id && !authExpired) void refreshMessageFromWorkspace();
    });

    if (authExpired) {
      // Keep server-rendered metadata visible while the user reauthenticates.
    } else if (message.source === 'inbound') {
      inboundDetailPending = true;
      void fetchInboundDetail(message.id, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) inboundDetail = result.detail;
        })
        .catch((error) => {
          if (!controller.signal.aborted) inboundDetailError = errorMessage(error, t('mail.bodyLoadFailed'));
        })
        .finally(() => {
          if (!controller.signal.aborted) inboundDetailPending = false;
        });
    } else {
      workspaceBodyPending = true;
      void fetchMessageBody(message.id, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          workspaceBody = result.body;
          workspaceAttachments = result.attachments;
        })
        .catch((error) => {
          if (!controller.signal.aborted) workspaceBodyError = errorMessage(error, t('mail.bodyLoadFailed'));
        })
        .finally(() => {
          if (!controller.signal.aborted) workspaceBodyPending = false;
        });

      if (message.folder === 'sent') {
        deliveryDetailPending = true;
        void fetchDeliveryDetail(message.id, controller.signal)
          .then((result) => {
            if (!controller.signal.aborted) deliveryDetail = result.detail;
          })
          .catch((error) => {
            if (!controller.signal.aborted) deliveryDetailError = errorMessage(error, t('mail.deliveryDetailFailed'));
          })
          .finally(() => {
            if (!controller.signal.aborted) deliveryDetailPending = false;
          });
      }
    }

    return () => {
      controller.abort();
      mounted = false;
      activeController = null;
      window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
      sync?.close();
      sync = null;
      authSessionSync?.close();
      authSessionSync = null;
    };
  });
</script>

<svelte:head>
  <title>{message.subject || t('mail.noSubject')} · FlareMail</title>
</svelte:head>

<div class="min-h-screen bg-[var(--fm-canvas)] text-[var(--fm-text)]">
  <div class="mx-auto flex min-h-screen w-full max-w-[96rem] flex-col px-3 py-3 sm:px-6 sm:py-6">
    <header class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--fm-border)] pb-3">
      <a class="inline-flex min-h-11 items-center rounded-[var(--radius-md)] px-3 text-sm font-medium text-[var(--fm-primary)] hover:bg-[var(--fm-primary-soft)]" href={data.backHref}>
        {t('reader.returnWorkspace')}
      </a>
      <span class="sr-only">{t('reader.currentAccount', { email: data.profile.email })}</span>
      <div class="flex items-center gap-2">
        <LanguageSwitcher />
        <span class="text-xs text-[var(--fm-text-muted)]">{t('reader.standalone')}</span>
      </div>
    </header>

    {#if authExpired}
      <AuthExpiredNotice
        busy={authRecoveryPending}
        error={authRecoveryError}
        onOpenSignIn={() => openReauthenticationTab()}
        onRetry={recoverExpiredSession}
      />
    {/if}

    <main class="fm-reader-body min-h-0 flex-1 overflow-hidden pt-3 sm:pt-6">
      {#if mutationError}
        <p class="mb-3 rounded-[var(--radius-md)] border border-[var(--fm-danger)]/35 bg-[var(--fm-danger-soft)] px-3 py-2 text-xs text-[var(--fm-danger)]" role="alert">{mutationError}</p>
      {/if}
      <MessageDetail
        {message}
        {inboundDetail}
        {inboundDetailError}
        {inboundDetailPending}
        rawDownloadHref={message.source === 'inbound' ? `/api/workspace/messages/${encodeURIComponent(message.id)}/raw` : null}
        {deliveryDetail}
        {deliveryDetailError}
        {deliveryDetailPending}
        {workspaceBody}
        {workspaceAttachments}
        {workspaceBodyError}
        {workspaceBodyPending}
        {pending}
        onToggleStar={() => void updateFlags({ starred: !message.starred })}
        onToggleRead={message.folder === 'inbox' ? () => void updateFlags({ read: !message.read }) : undefined}
        onReply={() => returnToWorkspace('reply')}
        onForward={() => returnToWorkspace('forward')}
      />
    </main>
  </div>
</div>
