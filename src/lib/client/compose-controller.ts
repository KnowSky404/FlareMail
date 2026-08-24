import { parseAddressList } from '$lib/domain/mail';
import type { ComposeInput, MailMessage } from '$lib/domain/mail';
import { ComposeSaveSequence } from './compose-save-sequence';

export function createEmptyComposeInput(): ComposeInput {
  return { to: [], cc: [], bcc: [], toEmail: '', attachments: [], attachmentRevision: 0, subject: '', body: '', html: '' };
}

export function serializeComposeInput(input: ComposeInput | null) {
  if (!input) return '';
  return JSON.stringify({
    draftId: input.draftId?.trim() || null,
    bodyRevision: input.bodyRevision ?? null,
    to: parseAddressList(input.to ?? input.toEmail ?? ''),
    cc: parseAddressList(input.cc ?? ''),
    bcc: parseAddressList(input.bcc ?? ''),
    subject: input.subject,
    body: input.body,
    html: input.html ?? '',
    attachmentIds: (input.attachments ?? []).map((attachment) => attachment.id).filter(Boolean),
    attachmentRevision: input.attachmentRevision ?? 0,
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
  persistence: Pick<ComposeInput, 'draftId' | 'expectedUpdatedAt' | 'bodyRevision'> | null
) {
  return {
    ...input,
    draftId: persistence?.draftId ?? input.draftId,
    expectedUpdatedAt: persistence?.expectedUpdatedAt ?? input.expectedUpdatedAt,
    bodyRevision: persistence?.bodyRevision ?? input.bodyRevision
  };
}

export function hasComposeContent(input: ComposeInput | null) {
  return Boolean(input && (parseAddressList(input.to ?? input.toEmail ?? '').length || parseAddressList(input.cc ?? '').length || parseAddressList(input.bcc ?? '').length || input.subject.trim() || input.body.trim() || input.html?.trim() || input.attachments?.length));
}

export function composeInputFromSavedDraft(
  message: MailMessage,
  bodyRevision?: string | null,
  attachments: ComposeInput['attachments'] = [],
  attachmentRevision = 0
): ComposeInput {
  return {
    draftId: message.id,
    to: message.toAddresses ?? parseAddressList(message.toEmail),
    cc: message.ccAddresses ?? parseAddressList(message.cc ?? ''),
    bcc: message.bccAddresses ?? parseAddressList(message.bcc ?? ''),
    toEmail: message.toEmail,
    subject: message.subject === '未命名草稿' ? '' : message.subject,
    body: message.body,
    html: message.html ?? '',
    attachments,
    attachmentRevision,
    messageId: message.messageId,
    inReplyTo: message.inReplyTo,
    references: message.references,
    expectedUpdatedAt: message.sentAt,
    ...(bodyRevision ? { bodyRevision } : {})
  };
}

export function mergeSavedDraftMetadata(
  input: ComposeInput,
  message: MailMessage,
  bodyRevision?: string | null,
  attachments: ComposeInput['attachments'] = input.attachments,
  attachmentRevision = input.attachmentRevision ?? 0
): ComposeInput {
  return {
    ...withComposePersistence(input, {
      draftId: message.id,
      expectedUpdatedAt: message.sentAt
    }),
    attachments,
    attachmentRevision,
    ...(bodyRevision ? { bodyRevision } : { bodyRevision: undefined })
  };
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
