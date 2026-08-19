import { normalizeMessageId, parseMessageIds } from './thread';
import { dedupeAddresses, parseAddressList, serializeAddressList } from './addresses';
import type {
  ComposeInput,
  DraftMessageInput,
  MailMessage,
  SentMessageInput,
  UserProfile
} from './types';

const normalizePreview = (value: string) => value.trim().replace(/\s+/g, ' ').slice(0, 96);
const deriveToName = (email: string) => email.split('@')[0].replace(/[._-]/g, ' ').trim() || email.trim();

function prefixedSubject(prefix: 'Re' | 'Fwd', subject: string): string {
  const trimmed = subject.trim() || '(no subject)';
  const normalizedPrefix = `${prefix.toLowerCase()}:`;
  return trimmed.toLowerCase().startsWith(normalizedPrefix) ? trimmed : `${prefix}: ${trimmed}`;
}

function quoteBody(value: string): string {
  return value
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function canonicalMessageId(value: string | null | undefined): string | undefined {
  const normalized = value ? normalizeMessageId(value) : null;
  return normalized ? `<${normalized}>` : undefined;
}

function composeAddresses(input: { to?: DraftMessageInput['to']; toEmail?: string; cc?: DraftMessageInput['cc']; bcc?: DraftMessageInput['bcc'] }) {
  const to = dedupeAddresses(parseAddressList(input.to ?? input.toEmail ?? ''));
  const used = new Set(to.map((address) => address.email));
  const uniqueField = (value: DraftMessageInput['cc'] | DraftMessageInput['bcc']) => dedupeAddresses(parseAddressList(value)).filter((address) => {
    if (used.has(address.email)) return false;
    used.add(address.email);
    return true;
  });
  return {
    to,
    cc: uniqueField(input.cc),
    bcc: uniqueField(input.bcc)
  };
}

function composeReferences(message: Pick<MailMessage, 'references' | 'inReplyTo' | 'messageId'>): string | undefined {
  const ids = [...parseMessageIds(message.references), ...parseMessageIds(message.inReplyTo), ...parseMessageIds(message.messageId)];
  const unique = ids.filter((id, index) => ids.indexOf(id) === index);
  return unique.length ? unique.map((id) => `<${id}>`).join(' ') : undefined;
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function sharedRfcFields(input: { messageId?: string | null; inReplyTo?: string | null; references?: string | null }) {
  const references = parseMessageIds(input.references)
    .map((id) => `<${id}>`)
    .join(' ') || undefined;
  return {
    messageId: canonicalMessageId(input.messageId),
    inReplyTo: canonicalMessageId(input.inReplyTo),
    references
  };
}

/** Build a new draft without any provider or framework dependencies. */
export function createDraftMessage(input: DraftMessageInput): MailMessage {
  const recipients = composeAddresses(input);
  const toEmail = recipients.to[0]?.email ?? (input.to === undefined ? input.toEmail?.trim() ?? '' : '');
  const body = input.body.trim();
  const rfc = sharedRfcFields(input);

  return {
    id: input.id ?? createId('draft-live'),
    folder: 'drafts',
    source: 'workspace',
    fromName: input.from.name,
    fromEmail: input.from.email,
    toName: recipients.to[0]?.name || (toEmail ? deriveToName(toEmail) : '待填写'),
    toEmail,
    cc: serializeAddressList(recipients.cc),
    bcc: serializeAddressList(recipients.bcc),
    toAddresses: recipients.to,
    ccAddresses: recipients.cc,
    bccAddresses: recipients.bcc,
    subject: input.subject.trim() || '未命名草稿',
    preview: normalizePreview(body || '继续补充内容…'),
    body,
    sentAt: input.updatedAt ?? new Date().toISOString(),
    labels: ['Draft'],
    read: true,
    starred: input.starred ?? false,
    deliveryStatus: 'draft',
    ...rfc
  };
}

/** Build a sent message in the submitted/queued state, never delivered by implication. */
export function createSentMessage(input: SentMessageInput): MailMessage {
  const recipients = composeAddresses(input);
  const toEmail = recipients.to[0]?.email ?? (input.to === undefined ? input.toEmail?.trim() ?? '' : '');
  const signatureBlock = input.from.signature ? `\n\n${input.from.signature}` : '';
  const cc = serializeAddressList(recipients.cc);
  const body = input.body.trim();
  const rfc = sharedRfcFields(input);

  return {
    id: input.id ?? createId('sent-live'),
    folder: 'sent',
    source: 'workspace',
    fromName: input.from.name,
    fromEmail: input.from.email,
    toName: recipients.to[0]?.name || deriveToName(toEmail),
    toEmail,
    cc,
    bcc: serializeAddressList(recipients.bcc),
    toAddresses: recipients.to,
    ccAddresses: recipients.cc,
    bccAddresses: recipients.bcc,
    subject: input.subject.trim(),
    preview: normalizePreview(body),
    body: `${body}${signatureBlock}`,
    sentAt: input.sentAt ?? new Date().toISOString(),
    labels: ['Sent'],
    read: true,
    starred: input.starred ?? false,
    deliveryStatus: input.deliveryStatus ?? 'queued',
    deliveryAttempts: input.deliveryAttempts ?? 0,
    deliveryError: input.deliveryError ?? '',
    deliveredAt: input.deliveredAt ?? null,
    deliveryProvider: input.deliveryProvider ?? null,
    deliveryResultKind: input.deliveryResultKind ?? null,
    deliveryRemoteStatus: input.deliveryRemoteStatus ?? null,
    deliveryResponsePreview: input.deliveryResponsePreview ?? '',
    deliveryLastEvent: input.deliveryLastEvent ?? null,
    deliveryLastEventAt: input.deliveryLastEventAt ?? null,
    ...rfc
  };
}

export function createComposeInputFromDraft(message: MailMessage): ComposeInput {
  return {
    draftId: message.folder === 'drafts' ? message.id : undefined,
    expectedUpdatedAt: message.folder === 'drafts' ? message.sentAt : undefined,
    to: message.toAddresses ?? parseAddressList(message.toEmail),
    cc: message.ccAddresses ?? parseAddressList(message.cc ?? ''),
    bcc: message.bccAddresses ?? parseAddressList(message.bcc ?? ''),
    toEmail: message.toEmail,
    subject: message.subject === '未命名草稿' ? '' : message.subject,
    body: message.body,
    messageId: message.messageId,
    inReplyTo: message.inReplyTo,
    references: message.references
  };
}

export function createReplyComposeInput(message: MailMessage, quotedBody = message.body): ComposeInput {
  const inReplyTo = canonicalMessageId(message.messageId);
  const references = composeReferences(message);

  return {
    to: [{ name: message.fromName, email: message.fromEmail }],
    cc: [],
    bcc: [],
    toEmail: message.fromEmail,
    subject: prefixedSubject('Re', message.subject),
    body: `Hi ${message.fromName},\n\n\n\n在 ${message.sentAt}，${message.fromName} <${message.fromEmail}> 写道：\n${quoteBody(quotedBody)}`,
    inReplyTo,
    references
  };
}

export function createForwardComposeInput(message: MailMessage, forwardedBody = message.body): ComposeInput {
  return {
    to: [],
    cc: [],
    bcc: [],
    toEmail: '',
    subject: prefixedSubject('Fwd', message.subject),
    body: `Hi,\n\n转发给你参考。\n\n---------- 转发邮件 ----------\n发件人: ${message.fromName} <${message.fromEmail}>\n收件人: ${message.toName} <${message.toEmail}>\n时间: ${message.sentAt}\n主题: ${message.subject}\n\n${forwardedBody}`
  };
}

// Short names make the domain API convenient for services while the verbose
// names preserve compatibility with the existing mock mailbox API.
export const createDraft = createDraftMessage;
export const createSent = createSentMessage;
export const createReply = createReplyComposeInput;
export const createForward = createForwardComposeInput;
