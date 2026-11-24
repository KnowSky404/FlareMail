export const WORKSPACE_SESSION_ENDED_EVENT = 'flaremail:workspace-session-ended';
export const WORKSPACE_SYNC_CHANNEL = 'flaremail-workspace-v1';
export const WORKSPACE_SYNC_STORAGE_KEY = 'flaremail-workspace-sync-v1';

export type WorkspaceSyncEvent =
  | { type: 'message-updated'; id: string; delivery?: true }
  | { type: 'mailbox-refresh'; id?: string; delivery?: true }
  | { type: 'delivery-attention-changed'; id?: string }
  | { type: 'blocked-senders-changed' }
  | { type: 'mail-identity-options-changed' }
  | { type: 'session-ended' };

export type WorkspaceSyncController = {
  publish: (event: WorkspaceSyncEvent) => void;
  close: () => void;
};

export function parseWorkspaceSyncEvent(value: unknown): WorkspaceSyncEvent | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as { type?: unknown; id?: unknown; delivery?: unknown };
  if (input.type === 'session-ended') return { type: 'session-ended' };
  const id = typeof input.id === 'string' && input.id.length > 0 ? input.id : undefined;
  if (input.type === 'message-updated' && id) {
    return { type: input.type, id, ...(input.delivery === true ? { delivery: true } : {}) };
  }
  if (input.type === 'mailbox-refresh') {
    return { type: input.type, ...(id ? { id } : {}), ...(input.delivery === true ? { delivery: true } : {}) };
  }
  if (input.type === 'delivery-attention-changed') return { type: input.type, ...(id ? { id } : {}) };
  if (input.type === 'mail-identity-options-changed') return { type: 'mail-identity-options-changed' };
  if (input.type === 'blocked-senders-changed') return { type: 'blocked-senders-changed' };
  return null;
}

const randomNonce = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return Math.random().toString(36).slice(2);
  }
};

/** Synchronize only state-change signals; message bodies and addresses never cross the channel. */
export function createWorkspaceSync(onEvent: (event: WorkspaceSyncEvent) => void): WorkspaceSyncController {
  if (typeof window === 'undefined') {
    return { publish: () => undefined, close: () => undefined };
  }

  let channel: BroadcastChannel | null = null;
  try {
    channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(WORKSPACE_SYNC_CHANNEL);
  } catch {
    channel = null;
  }

  const receivedNonces = new Set<string>();
  const receive = (value: unknown) => {
    if (value && typeof value === 'object') {
      const nonce = (value as { nonce?: unknown }).nonce;
      if (typeof nonce === 'string') {
        if (receivedNonces.has(nonce)) return;
        receivedNonces.add(nonce);
        if (receivedNonces.size > 32) receivedNonces.delete(receivedNonces.values().next().value as string);
      }
    }
    const event = parseWorkspaceSyncEvent(value);
    if (event) onEvent(event);
  };
  const receiveChannel = (event: MessageEvent<unknown>) => receive(event.data);
  const receiveStorage = (event: StorageEvent) => {
    if (event.key !== WORKSPACE_SYNC_STORAGE_KEY || !event.newValue) return;
    try {
      receive(JSON.parse(event.newValue));
    } catch {
      // Ignore malformed values from other browser contexts.
    }
  };

  channel?.addEventListener('message', receiveChannel);
  window.addEventListener('storage', receiveStorage);

  return {
    publish: (event) => {
      const envelope = { ...event, nonce: randomNonce(), at: Date.now() };
      channel?.postMessage(envelope);
      try {
        window.localStorage.setItem(WORKSPACE_SYNC_STORAGE_KEY, JSON.stringify(envelope));
      } catch {
        // Private browsing and disabled storage are supported by BroadcastChannel when available.
      }
    },
    close: () => {
      channel?.removeEventListener('message', receiveChannel);
      channel?.close();
      window.removeEventListener('storage', receiveStorage);
    }
  };
}
