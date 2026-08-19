export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export type ToastMessage = {
  id: string;
  tone: ToastTone;
  message: string;
  requestId?: string;
  actionLabel?: string;
  persistent: boolean;
};

export type ToastInput = {
  tone: ToastTone;
  message: string;
  requestId?: string;
  timeoutMs?: number;
  persistent?: boolean;
  action?: { label: string; run: () => void | Promise<void> };
};

export class ToastController {
  private messages: ToastMessage[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly actions = new Map<string, () => void | Promise<void>>();

  constructor(private readonly onChange: (messages: ToastMessage[]) => void) {}

  push(input: ToastInput) {
    const id = crypto.randomUUID();
    const persistent = input.persistent ?? input.tone === 'error';
    const message: ToastMessage = {
      id,
      tone: input.tone,
      message: input.message,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.action ? { actionLabel: input.action.label } : {}),
      persistent
    };
    const nextMessages = [...this.messages.slice(-3), message];
    for (const current of this.messages) {
      if (!nextMessages.some(({ id: nextId }) => nextId === current.id)) this.clearResources(current.id);
    }
    this.messages = nextMessages;
    if (input.action) this.actions.set(id, input.action.run);
    const timeoutMs = input.timeoutMs ?? (persistent ? 0 : 5_000);
    if (timeoutMs > 0) this.timers.set(id, setTimeout(() => this.dismiss(id), timeoutMs));
    this.emit();
    return id;
  }

  dismiss(id: string) {
    this.clearResources(id);
    this.messages = this.messages.filter((message) => message.id !== id);
    this.emit();
  }

  async invoke(id: string) {
    const action = this.actions.get(id);
    if (!action) return;
    await action();
    this.dismiss(id);
  }

  reset() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.actions.clear();
    this.messages = [];
    this.emit();
  }

  private emit() {
    this.onChange([...this.messages]);
  }

  private clearResources(id: string) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.actions.delete(id);
  }
}
