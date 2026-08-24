export type WorkspaceShortcutAction =
  | 'close-help'
  | 'close-mobile-detail'
  | 'folder-inbox'
  | 'folder-sent'
  | 'folder-drafts'
  | 'focus-search'
  | 'compose'
  | 'next-message'
  | 'previous-message'
  | 'reply'
  | 'reply-all'
  | 'forward'
  | 'open-help';

export type WorkspaceShortcutContext = {
  helpOpen: boolean;
  mobileDetailOpen: boolean;
  canReply: boolean;
  canReplyAll: boolean;
  canForward: boolean;
};

function editableTarget(target: EventTarget | null) {
  return (
    (typeof HTMLInputElement !== 'undefined' && target instanceof HTMLInputElement) ||
    (typeof HTMLTextAreaElement !== 'undefined' && target instanceof HTMLTextAreaElement) ||
    (typeof HTMLSelectElement !== 'undefined' && target instanceof HTMLSelectElement) ||
    (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && target.isContentEditable)
  );
}

export class WorkspaceShortcutController {
  private prefix = '';
  private prefixTimer: ReturnType<typeof setTimeout> | null = null;

  handle(event: KeyboardEvent, context: WorkspaceShortcutContext): WorkspaceShortcutAction | null {
    let action: WorkspaceShortcutAction | null = null;
    if (event.key === 'Escape') {
      action = context.helpOpen ? 'close-help' : context.mobileDetailOpen ? 'close-mobile-detail' : null;
    } else if (!editableTarget(event.target) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const key = event.key.toLocaleLowerCase('en-US');
      if (this.prefix === 'g' && (key === 'i' || key === 's' || key === 'd')) {
        this.clearPrefix();
        action = key === 'i' ? 'folder-inbox' : key === 's' ? 'folder-sent' : 'folder-drafts';
      } else if (key === 'g') {
        this.setPrefix();
        event.preventDefault();
      } else if (key === '/') action = 'focus-search';
      else if (key === 'c') action = 'compose';
      else if (key === 'j') action = 'next-message';
      else if (key === 'k') action = 'previous-message';
      else if (key === 'r' && context.canReply) action = 'reply';
      else if (key === 'a' && context.canReplyAll) action = 'reply-all';
      else if (key === 'f' && context.canForward) action = 'forward';
      else if (event.key === '?') action = 'open-help';
    }
    if (action) event.preventDefault();
    return action;
  }

  dispose() {
    this.clearPrefix();
  }

  private setPrefix() {
    this.clearPrefix();
    this.prefix = 'g';
    this.prefixTimer = setTimeout(() => this.clearPrefix(), 900);
  }

  private clearPrefix() {
    this.prefix = '';
    if (this.prefixTimer) clearTimeout(this.prefixTimer);
    this.prefixTimer = null;
  }
}
