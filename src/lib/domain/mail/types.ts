/**
 * Provider and framework independent mail contracts.
 *
 * The mock mailbox used by the first version of FlareMail has a similar shape,
 * but domain code must not import it. Optional RFC fields deliberately accept
 * null because old rows can predate threading metadata.
 */

export type MailFolder = 'inbox' | 'sent' | 'drafts';
export type MailSource = 'workspace' | 'inbound';

export type DeliveryStatus =
  | 'draft'
  | 'queued'
  | 'submitting'
  | 'submitted'
  | 'sent'
  | 'delivered'
  | 'delayed'
  | 'bounced'
  | 'failed'
  | 'complained'
  | 'suppressed';

export type DeliveryResultKind =
  | 'accepted'
  | 'queued'
  | 'temporary_failure'
  | 'permanent_failure'
  | 'rate_limited';

/** Known provider events plus future provider event names. */
export type DeliveryEventType =
  | 'submission'
  | 'email.sent'
  | 'email.delivered'
  | 'email.delivery_delayed'
  | 'email.bounced'
  | 'email.complained'
  | 'email.failed'
  | 'email.suppressed'
  | 'email.opened'
  | 'email.clicked'
  | (string & {});

export type ComposeMode = 'new' | 'draft' | 'reply' | 'forward';

export const inboundMessagePrefix = 'email:';

export const isInboundMessageId = (value: string): boolean =>
  value.startsWith(inboundMessagePrefix);

export const toInboundMessageId = (value: string): string =>
  `${inboundMessagePrefix}${value}`;

export const fromInboundMessageId = (value: string): string =>
  isInboundMessageId(value) ? value.slice(inboundMessagePrefix.length) : value;

/** RFC 5322 threading fields, without tying the domain to a Headers API. */
export interface MailRfcHeaders {
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}

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

export interface MailMessage extends MailRfcHeaders {
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
  threadKey?: string | null;
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
  messageId?: string | null;
  providerMessageId?: string | null;
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

export interface ComposeInput extends MailRfcHeaders {
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

export interface DraftMessageInput {
  id?: string;
  from: UserProfile;
  toEmail: string;
  cc?: string;
  subject: string;
  body: string;
  starred?: boolean;
  updatedAt?: string;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}

export interface SentMessageInput extends Omit<DraftMessageInput, 'updatedAt'> {
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
  sentAt?: string;
}

export interface DeliveryState {
  status: DeliveryStatus;
  attempts?: number;
  error?: string | null;
  deliveredAt?: string | null;
  providerMessageId?: string | null;
  lastEvent?: DeliveryEventType | null;
  lastEventAt?: string | null;
}

export function cloneMessage(message: MailMessage): MailMessage {
  return { ...message, labels: [...message.labels] };
}

export function cloneMailbox(mailbox: MailboxState = { inbox: [], sent: [], drafts: [] }): MailboxState {
  return {
    inbox: mailbox.inbox.map(cloneMessage),
    sent: mailbox.sent.map(cloneMessage),
    drafts: mailbox.drafts.map(cloneMessage)
  };
}

export function cloneProfile(profile: UserProfile = {
  name: '',
  role: '',
  email: '',
  company: '',
  location: '',
  timezone: 'UTC',
  forwardingEnabled: false,
  signature: ''
}): UserProfile {
  return { ...profile };
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

export function createWorkspacePayload(
  profile: UserProfile,
  mailbox: MailboxState
): WorkspacePayload {
  return {
    profile: cloneProfile(profile),
    mailbox: cloneMailbox(mailbox),
    metrics: getMailboxMetrics(mailbox)
  };
}
