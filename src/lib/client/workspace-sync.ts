export const WORKSPACE_SYNC_CHANNEL = 'flaremail-workspace-v1';
export const WORKSPACE_SYNC_STORAGE_KEY = 'flaremail-workspace-sync-v1';

export type WorkspaceSyncEvent =
  | { type: 'message-updated'; id: string }
  | { type: 'mailbox-refresh'; id?: string }
  | { type: 'session-ended' };

export type WorkspaceSyncController = {
  publish: (event: WorkspaceSyncEvent) => void;
  close: () => void;
};

export function parseWorkspaceSyncEvent(value: unknown): WorkspaceSyncEvent | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as { type?: unknown; id?: unknown };
  if (input.type === 'session-ended') return { type: 'session-ended' };
  if (input.type === 'message-updated' && typeof input.id === 'string' && input.id.length > 0) {
    return { type: 'message-updated', id: input.id };
  }
  if (input.type === 'mailbox-refresh') {
    return typeof input.id === 'string' && input.id.length > 0
      ? { type: 'mailbox-refresh', id: input.id }
      : { type: 'mailbox-refresh' };
  }
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
