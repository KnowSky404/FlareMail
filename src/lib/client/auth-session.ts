export const AUTH_EXPIRED_EVENT = 'flaremail:auth-expired';
export const AUTH_SESSION_CHANNEL = 'flaremail-auth-session-v1';

export type AuthExpirySource = 'worker-session' | 'access-edge' | 'access-login-redirect' | 'other-tab';
export type AuthSessionMessage = { type: 'expired' } | { type: 'authenticated' };

let authExpired = false;

export function isClientAuthExpired() {
  return authExpired;
}

export function markClientAuthExpired(source: AuthExpirySource) {
  if (authExpired) return;
  authExpired = true;
  if (typeof window === 'undefined') return;
  const detail = { source } satisfies { source: AuthExpirySource };
  const event = typeof CustomEvent === 'undefined'
    ? Object.assign(new Event(AUTH_EXPIRED_EVENT), { detail })
    : new CustomEvent(AUTH_EXPIRED_EVENT, { detail });
  window.dispatchEvent(event);
}

export function clearClientAuthExpired() {
  authExpired = false;
}

export function parseAuthSessionMessage(value: unknown): AuthSessionMessage | null {
  if (!value || typeof value !== 'object') return null;
  const type = (value as { type?: unknown }).type;
  return type === 'expired' || type === 'authenticated' ? { type } : null;
}

export function createAuthSessionChannel(onMessage: (message: AuthSessionMessage) => void) {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return { publish: (_message: AuthSessionMessage) => undefined, close: () => undefined };
  }

  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(AUTH_SESSION_CHANNEL);
  } catch {
    return { publish: (_message: AuthSessionMessage) => undefined, close: () => undefined };
  }

  const receive = (event: MessageEvent<unknown>) => {
    const message = parseAuthSessionMessage(event.data);
    if (message) onMessage(message);
  };
  channel.addEventListener('message', receive);
  return {
    publish: (message: AuthSessionMessage) => channel.postMessage(message),
    close: () => {
      channel.removeEventListener('message', receive);
      channel.close();
    }
  };
}

/** Return only a same-origin pathname; query data, hashes, and response URLs are never used. */
export function sameOriginReauthenticationPath(currentHref: string, expectedOrigin: string) {
  try {
    const current = new URL(currentHref);
    const origin = new URL(expectedOrigin);
    return current.origin === origin.origin && current.pathname.startsWith('/') && !current.pathname.startsWith('//')
      ? current.pathname
      : '/';
  } catch {
    return '/';
  }
}

export function openReauthenticationTab() {
  if (typeof window === 'undefined') return null;
  const path = sameOriginReauthenticationPath(window.location.href, window.location.origin);
  return window.open(path, '_blank', 'noopener,noreferrer');
}
