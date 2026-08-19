import type { ComposeInput, MailMessage } from '$lib/domain/mail';
import { ComposeSaveSequence } from './compose-save-sequence';

export function createEmptyComposeInput(): ComposeInput {
  return { toEmail: '', cc: '', subject: '', body: '' };
}

export function serializeComposeInput(input: ComposeInput | null) {
  if (!input) return '';
  return JSON.stringify({
    draftId: input.draftId?.trim() || null,
    toEmail: input.toEmail.trim(),
    cc: (input.cc ?? '').trim(),
    subject: input.subject,
    body: input.body,
    messageId: input.messageId ?? null,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ?? null
  });
}

export function withComposeDraftId(input: ComposeInput, draftId?: string) {
  return { ...input, draftId: draftId ?? input.draftId };
}

export function withComposePersistence(
  input: ComposeInput,
  persistence: Pick<ComposeInput, 'draftId' | 'expectedUpdatedAt'> | null
) {
  return {
    ...input,
    draftId: persistence?.draftId ?? input.draftId,
    expectedUpdatedAt: persistence?.expectedUpdatedAt ?? input.expectedUpdatedAt
  };
}

export function hasComposeContent(input: ComposeInput | null) {
  return Boolean(input && (input.toEmail.trim() || (input.cc ?? '').trim() || input.subject.trim() || input.body.trim()));
}

export function composeInputFromSavedDraft(message: MailMessage): ComposeInput {
  return {
    draftId: message.id,
    toEmail: message.toEmail,
    cc: message.cc ?? '',
    subject: message.subject === '未命名草稿' ? '' : message.subject,
    body: message.body,
    messageId: message.messageId,
    inReplyTo: message.inReplyTo,
    references: message.references,
    expectedUpdatedAt: message.sentAt
  };
}

export function mergeSavedDraftMetadata(input: ComposeInput, message: MailMessage): ComposeInput {
  return withComposePersistence(input, {
    draftId: message.id,
    expectedUpdatedAt: message.sentAt
  });
}

export function formatComposeSavedAt(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(value));
}

export class ComposeAutosaveController {
  readonly sequence = new ComposeSaveSequence();
  private timer: ReturnType<typeof setTimeout> | null = null;

  schedule(callback: () => void, delayMs = 1500) {
    this.clear();
    this.timer = setTimeout(callback, delayMs);
  }

  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  changed() {
    this.sequence.changed();
  }

  reset() {
    this.clear();
    this.sequence.reset();
  }
}
