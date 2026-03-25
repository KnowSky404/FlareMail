export type MailFolder = 'inbox' | 'sent' | 'drafts';
export type MailSource = 'workspace' | 'inbound';
export type DeliveryStatus = 'queued' | 'sent' | 'failed';
export type DeliveryResultKind =
  | 'accepted'
  | 'queued'
  | 'temporary_failure'
  | 'permanent_failure'
  | 'rate_limited';
export type DeliveryEventType =
  | 'submission'
  | 'email.sent'
  | 'email.delivered'
  | 'email.delivery_delayed'
  | 'email.bounced'
  | 'email.complained'
  | 'email.failed'
  | 'email.opened'
  | 'email.clicked';
export type ComposeMode = 'new' | 'draft' | 'reply' | 'forward';

export const inboundMessagePrefix = 'email:';

export interface MailAttachmentSummary {
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
}

export interface InboundMessageDetail {
  body: string;
  attachments: MailAttachmentSummary[];
  rawSize: number;
}

export const isInboundMessageId = (value: string) => value.startsWith(inboundMessagePrefix);
export const toInboundMessageId = (value: string) => `${inboundMessagePrefix}${value}`;
export const fromInboundMessageId = (value: string) =>
  isInboundMessageId(value) ? value.slice(inboundMessagePrefix.length) : value;

export interface MailMessage {
  id: string;
  folder: MailFolder;
  source: MailSource;
  fromName: string;
  fromEmail: string;
  toName: string;
  toEmail: string;
  cc?: string;
  subject: string;
  preview: string;
  body: string;
  sentAt: string;
  labels: string[];
  read: boolean;
  starred: boolean;
  deliveryStatus?: DeliveryStatus | null;
  deliveryAttempts?: number;
  deliveryError?: string;
  deliveredAt?: string | null;
  deliveryProvider?: string | null;
  deliveryResultKind?: DeliveryResultKind | null;
  deliveryRemoteStatus?: number | null;
  deliveryResponsePreview?: string;
  deliveryLastEvent?: DeliveryEventType | null;
  deliveryLastEventAt?: string | null;
}

export interface MailboxState {
  inbox: MailMessage[];
  sent: MailMessage[];
  drafts: MailMessage[];
}

export interface MailThread {
  id: string;
  subject: string;
  counterpartLabel: string;
  latestMessage: MailMessage;
  sectionLatestMessage: MailMessage;
  messages: MailMessage[];
  messageCount: number;
  sectionMessageCount: number;
  unreadCount: number;
  preview: string;
  sentAt: string;
}

export interface WorkspaceMetrics {
  unreadCount: number;
  starredCount: number;
  inboxCount: number;
  sentCount: number;
  draftsCount: number;
}

export interface UserProfile {
  name: string;
  role: string;
  email: string;
  company: string;
  location: string;
  timezone: string;
  forwardingEnabled: boolean;
  signature: string;
}

export interface WorkspacePayload {
  profile: UserProfile;
  mailbox: MailboxState;
  metrics: WorkspaceMetrics;
}

export interface DeliveryEvent {
  id: string;
  type: DeliveryEventType;
  createdAt: string;
  summary: string;
  payloadPreview?: string;
}

export interface DeliveryDetail {
  messageId: string;
  provider: string | null;
  resultKind: DeliveryResultKind | null;
  lastEvent: DeliveryEventType | null;
  lastEventAt: string | null;
  events: DeliveryEvent[];
}

export interface LoginInput {
  email: string;
  password: string;
  remember: boolean;
}

export interface ComposeInput {
  draftId?: string;
  toEmail: string;
  cc?: string;
  subject: string;
  body: string;
}

export interface MessagePatch {
  read?: boolean;
  starred?: boolean;
}

export const demoCredentials = {
  email: 'founder@flaremail.dev',
  password: 'flaremail-demo'
};

export const mockProfile: UserProfile = {
  name: 'FlareMail User',
  role: 'Workspace Owner',
  email: demoCredentials.email,
  company: 'FlareMail',
  location: '',
  timezone: 'Asia/Shanghai',
  forwardingEnabled: false,
  signature: ''
};

export const mockMailbox: MailboxState = {
  inbox: [],
  sent: [],
  drafts: []
};

const normalizePreview = (value: string) => value.trim().replace(/\s+/g, ' ').slice(0, 96);

const deriveToName = (email: string) => email.split('@')[0].replace(/[._-]/g, ' ').trim() || email.trim();

const prefixedSubject = (prefix: 'Re' | 'Fwd', subject: string) => {
  const trimmed = subject.trim() || '(no subject)';
  const normalizedPrefix = `${prefix.toLowerCase()}:`;
  return trimmed.toLowerCase().startsWith(normalizedPrefix) ? trimmed : `${prefix}: ${trimmed}`;
};

const quoteBody = (value: string) =>
  value
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

const createReplyThread = (message: MailMessage, body: string) =>
  ['',
    '',
    `在 ${message.sentAt}，${message.fromName} <${message.fromEmail}> 写道：`,
    quoteBody(body)
  ].join('\n');

const createForwardThread = (message: MailMessage, body: string) =>
  [
    '',
    '',
    '---------- 转发邮件 ----------',
    `发件人: ${message.fromName} <${message.fromEmail}>`,
    `收件人: ${message.toName} <${message.toEmail}>`,
    `时间: ${message.sentAt}`,
    `主题: ${message.subject}`,
    '',
    body
  ].join('\n');

const normalizeThreadSubject = (value: string) =>
  value
    .trim()
    .replace(/^(?:(?:re|fwd?)\s*:\s*)+/gi, '')
    .replace(/\s+/g, ' ')
    .toLowerCase() || '(no subject)';

const normalizeEmail = (value: string) => value.trim().toLowerCase();

const compareNewestFirst = (left: MailMessage, right: MailMessage) =>
  right.sentAt.localeCompare(left.sentAt) || right.id.localeCompare(left.id);

const compareOldestFirst = (left: MailMessage, right: MailMessage) =>
  left.sentAt.localeCompare(right.sentAt) || left.id.localeCompare(right.id);

const getCounterpartyEmail = (message: MailMessage) =>
  message.folder === 'inbox' ? message.fromEmail : message.toEmail;

const getCounterpartyLabel = (message: MailMessage) =>
  message.folder === 'inbox'
    ? `${message.fromName} <${message.fromEmail}>`
    : `${message.toName} <${message.toEmail}>`;

export function cloneMessage(message: MailMessage): MailMessage {
  return {
    ...message,
    labels: [...message.labels]
  };
}

export function cloneMailbox(mailbox: MailboxState = mockMailbox): MailboxState {
  return {
    inbox: mailbox.inbox.map(cloneMessage),
    sent: mailbox.sent.map(cloneMessage),
    drafts: mailbox.drafts.map(cloneMessage)
  };
}

export function cloneProfile(profile: UserProfile = mockProfile): UserProfile {
  return {
    ...profile
  };
}

export function getMailThreadKey(message: MailMessage): string {
  return `${normalizeThreadSubject(message.subject)}::${normalizeEmail(getCounterpartyEmail(message))}`;
}

export function buildMailThreads(
  mailbox: MailboxState,
  section: Exclude<MailFolder, 'drafts'>
): MailThread[] {
  const grouped = new Map<string, MailMessage[]>();
  const allMessages = [...mailbox.inbox.map(cloneMessage), ...mailbox.sent.map(cloneMessage)].sort(
    compareNewestFirst
  );

  for (const message of allMessages) {
    const threadKey = getMailThreadKey(message);
    const messages = grouped.get(threadKey);

    if (messages) {
      messages.push(message);
    } else {
      grouped.set(threadKey, [message]);
    }
  }

  return [...grouped.entries()]
    .map(([id, messages]) => {
      const sectionMessages = messages.filter((message) => message.folder === section);

      if (!sectionMessages.length) {
        return null;
      }

      const counterparties = [
        ...messages.reduce((accumulator, message) => {
          accumulator.set(normalizeEmail(getCounterpartyEmail(message)), getCounterpartyLabel(message));
          return accumulator;
        }, new Map<string, string>()).values()
      ];
      const latestMessage = messages[0];

      return {
        id,
        subject: latestMessage.subject,
        counterpartLabel:
          counterparties.length === 1
            ? counterparties[0]
            : `${counterparties[0]} 等 ${counterparties.length} 位联系人`,
        latestMessage,
        sectionLatestMessage: sectionMessages[0],
        messages: [...messages].sort(compareOldestFirst),
        messageCount: messages.length,
        sectionMessageCount: sectionMessages.length,
        unreadCount: messages.filter((message) => message.folder === 'inbox' && !message.read).length,
        preview: latestMessage.preview,
        sentAt: latestMessage.sentAt
      } satisfies MailThread;
    })
    .filter((thread): thread is MailThread => Boolean(thread))
    .sort((left, right) => right.sentAt.localeCompare(left.sentAt) || right.id.localeCompare(left.id));
}

export function getMailboxMetrics(mailbox: MailboxState): WorkspaceMetrics {
  return {
    unreadCount: mailbox.inbox.filter((message) => !message.read).length,
    starredCount:
      mailbox.inbox.filter((message) => message.starred).length +
      mailbox.sent.filter((message) => message.starred).length +
      mailbox.drafts.filter((message) => message.starred).length,
    inboxCount: mailbox.inbox.length,
    sentCount: mailbox.sent.length,
    draftsCount: mailbox.drafts.length
  };
}

export function createWorkspacePayload(profile: UserProfile, mailbox: MailboxState): WorkspacePayload {
  return {
    profile: cloneProfile(profile),
    mailbox: cloneMailbox(mailbox),
    metrics: getMailboxMetrics(mailbox)
  };
}

export function createDraftMessage(input: {
  id?: string;
  from: UserProfile;
  toEmail: string;
  cc?: string;
  subject: string;
  body: string;
  starred?: boolean;
  updatedAt?: string;
}): MailMessage {
  const subject = input.subject.trim() || '未命名草稿';
  const body = input.body.trim();
  const toEmail = input.toEmail.trim();

  return {
    id: input.id ?? `draft-live-${crypto.randomUUID()}`,
    folder: 'drafts',
    source: 'workspace',
    fromName: input.from.name,
    fromEmail: input.from.email,
    toName: toEmail ? deriveToName(toEmail) : '待填写',
    toEmail,
    cc: input.cc?.trim() ?? '',
    subject,
    preview: normalizePreview(body || '继续补充内容…'),
    body,
    sentAt: input.updatedAt ?? new Date().toISOString(),
    labels: ['Draft'],
    read: true,
    starred: input.starred ?? false
  };
}

export function createSentMessage(input: {
  id?: string;
  from: UserProfile;
  toEmail: string;
  subject: string;
  body: string;
  cc?: string;
  deliveryStatus?: DeliveryStatus;
  deliveryAttempts?: number;
  deliveryError?: string;
  deliveredAt?: string | null;
  deliveryProvider?: string | null;
  deliveryResultKind?: DeliveryResultKind | null;
  deliveryRemoteStatus?: number | null;
  deliveryResponsePreview?: string;
  deliveryLastEvent?: DeliveryEventType | null;
  deliveryLastEventAt?: string | null;
}): MailMessage {
  const toEmail = input.toEmail.trim();
  const signatureBlock = input.from.signature ? `\n\n${input.from.signature}` : '';
  const ccLine = input.cc?.trim() ? `CC: ${input.cc.trim()}\n\n` : '';
  const body = input.body.trim();
  const messageBody = `${ccLine}${body}${signatureBlock}`;

  return {
    id: input.id ?? `sent-live-${crypto.randomUUID()}`,
    folder: 'sent',
    source: 'workspace',
    fromName: input.from.name,
    fromEmail: input.from.email,
    toName: deriveToName(toEmail),
    toEmail,
    cc: input.cc?.trim() ?? '',
    subject: input.subject.trim(),
    preview: normalizePreview(body),
    body: messageBody,
    sentAt: new Date().toISOString(),
    labels: ['Sent'],
    read: true,
    starred: false,
    deliveryStatus: input.deliveryStatus ?? 'queued',
    deliveryAttempts: input.deliveryAttempts ?? 0,
    deliveryError: input.deliveryError ?? '',
    deliveredAt: input.deliveredAt ?? null,
    deliveryProvider: input.deliveryProvider ?? null,
    deliveryResultKind: input.deliveryResultKind ?? null,
    deliveryRemoteStatus: input.deliveryRemoteStatus ?? null,
    deliveryResponsePreview: input.deliveryResponsePreview ?? '',
    deliveryLastEvent: input.deliveryLastEvent ?? null,
    deliveryLastEventAt: input.deliveryLastEventAt ?? null
  };
}

export function createComposeInputFromDraft(message: MailMessage): ComposeInput {
  return {
    draftId: message.folder === 'drafts' ? message.id : undefined,
    toEmail: message.toEmail,
    cc: message.cc ?? '',
    subject: message.subject === '未命名草稿' ? '' : message.subject,
    body: message.body
  };
}

export function createReplyComposeInput(message: MailMessage, quotedBody = message.body): ComposeInput {
  return {
    toEmail: message.fromEmail,
    cc: '',
    subject: prefixedSubject('Re', message.subject),
    body: `Hi ${message.fromName},\n\n${createReplyThread(message, quotedBody)}`
  };
}

export function createForwardComposeInput(message: MailMessage, forwardedBody = message.body): ComposeInput {
  return {
    toEmail: '',
    cc: '',
    subject: prefixedSubject('Fwd', message.subject),
    body: `Hi,\n\n转发给你参考。${createForwardThread(message, forwardedBody)}`
  };
}
