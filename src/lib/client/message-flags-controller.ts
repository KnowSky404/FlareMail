import type { MailMessage, MessagePatch } from '$lib/domain/mail';
import type { MessageDelta } from './mailbox-controller';

type Flags = Pick<MailMessage, 'read' | 'starred'>;
type FlagKey = keyof Flags;
const keys: FlagKey[] = ['read', 'starred'];

/** Serializes writes per message; reconciles only fields whose intent is current. */
export class MessageFlagsController {
  private epoch = 0;
  private revision = 0;
  private readonly queues = new Map<string, Promise<boolean>>();
  private readonly states = new Map<string, { confirmed: Flags; versions: Partial<Record<FlagKey, number>>; pending: MessagePatch }>();

  constructor(private readonly callbacks: {
    onPatch: (id: string, patch: MessagePatch) => void;
    onConfirmed: (result: MessageDelta, metricsCurrent: boolean) => void;
    onError: (error: unknown) => void;
    onSettled?: () => void;
  }) {}

  get busy() { return this.queues.size > 0; }

  overlay(message: MailMessage): MailMessage {
    return { ...message, ...this.states.get(message.id)?.pending };
  }

  update(message: MailMessage, patch: MessagePatch, send: () => Promise<MessageDelta>): Promise<boolean> {
    const epoch = this.epoch;
    const revision = ++this.revision;
    const prior = this.queues.get(message.id);
    const state = this.states.get(message.id) ?? { confirmed: { read: message.read, starred: message.starred }, versions: {}, pending: {} };
    if (!prior) state.confirmed = { read: message.read, starred: message.starred };
    for (const key of keys) if (patch[key] !== undefined) { state.versions[key] = revision; state.pending[key] = patch[key]; }
    this.states.set(message.id, state);
    this.callbacks.onPatch(message.id, patch);
    const currentFields = (flags: Flags) => Object.fromEntries(keys.filter((key) => patch[key] !== undefined && state.versions[key] === revision).map((key) => [key, flags[key]]));
    let operation!: Promise<boolean>;
    operation = (async () => {
      await prior;
      if (epoch !== this.epoch) return false;
      try {
        const result = await send();
        if (epoch !== this.epoch) return false;
        state.confirmed = { read: result.message.read, starred: result.message.starred };
        this.callbacks.onPatch(message.id, currentFields(state.confirmed));
        this.callbacks.onConfirmed(result, revision === this.revision);
        return true;
      } catch (error) {
        if (epoch === this.epoch) {
          this.callbacks.onPatch(message.id, currentFields(state.confirmed));
          this.callbacks.onError(error);
        }
        return false;
      } finally {
        if (epoch === this.epoch) for (const key of keys) if (state.versions[key] === revision) delete state.pending[key];
        if (epoch === this.epoch && this.queues.get(message.id) === operation) {
          this.queues.delete(message.id);
          this.callbacks.onSettled?.();
        }
      }
    })();
    this.queues.set(message.id, operation);
    return operation;
  }

  reset() {
    this.epoch++;
    this.revision++;
    this.queues.clear();
    this.states.clear();
  }

  async flush() { await Promise.all(this.queues.values()); }
}

/** One auto-read per visible opening; a manual unread does not reopen the reader. */
export class ReadActivationController {
  private activeId: string | null = null;
  activate(message: Pick<MailMessage, 'id' | 'folder' | 'read'> | null): boolean {
    const id = message?.id ?? null;
    if (id === this.activeId) return false;
    this.activeId = id;
    return Boolean(message?.folder === 'inbox' && !message.read);
  }
  reset() { this.activeId = null; }
}
