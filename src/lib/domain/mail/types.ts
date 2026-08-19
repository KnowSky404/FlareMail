import type { MailAddress, MailAddressInput } from './addresses';

/**
 * Provider and framework independent mail contracts.
 *
 * The mock mailbox used by the first version of FlareMail has a similar shape,
 * but domain code must not import it. Optional RFC fields deliberately accept
 * null because old rows can predate threading metadata.
 */

export type MailFolder = 'inbox' | 'sent' | 'drafts';
/** A persisted mail folder plus the user-facing archive section. */
export type MailboxSection = MailFolder | 'archive';
export type MailSource = 'workspace' | 'inbound';
export type MailSearchHitField = 'all' | 'from' | 'to' | 'cc' | 'subject' | 'label' | 'state' | 'attachment' | 'date' | 'status';

export type MailboxMutationAction = 'archive' | 'unarchive' | 'read' | 'unread' | 'star' | 'unstar' | 'trash';

export interface MailboxMutationRequest {
  action: MailboxMutationAction;
  ids?: string[];
  threadKeys?: string[];
}

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
  id?: string;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
  contentId?: string | null;
  downloadUrl?: string;
  disposition?: 'attachment' | 'inline';
  state?: 'uploading' | 'ready' | 'failed' | 'delete_pending';
  sha256?: string | null;
}

export interface MailTechnicalHeader {
  name: string;
  value: string;
}

export interface MailAuthenticationResult {
  method: 'spf' | 'dkim' | 'dmarc';
  result: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror' | 'policy';
}

export interface InboundMessageDetail {
  body: string;
  attachments: MailAttachmentSummary[];
  rawSize: number;
  hasHtml?: boolean;
  toAddresses: MailAddress[];
  ccAddresses: MailAddress[];
  replyTo: MailAddress[];
  date: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  returnPath: string | null;
  deliveredTo: string | null;
  headers: MailTechnicalHeader[];
  authenticationResults: MailAuthenticationResult[];
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
  /** Canonical recipients; legacy display strings remain for old UI/readers. */
  toAddresses?: MailAddress[];
  ccAddresses?: MailAddress[];
  bccAddresses?: MailAddress[];
  bcc?: string;
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
  deliveryIdempotencyKey?: string | null;
  deliveryAttemptStartedAt?: string | null;
  /** Non-null only when an inbox message is in the archive section. */
  archivedAt?: string | null;
  /** Safe plain text with private-use highlight delimiters from FTS5. */
  searchSnippet?: string;
  searchHitFields?: MailSearchHitField[];
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
  trashCount: number;
  queuedCount: number;
  delayedCount: number;
  failedCount: number;
  bouncedCount: number;
  complainedCount: number;
  staleDeliveryCount: number;
}

export type TrashItemKind = 'workspace' | 'draft' | 'inbound';

export interface TrashItem {
  id: string;
  kind: TrashItemKind;
  deletedAt: string;
  originalFolder: MailboxSection;
  message: MailMessage;
}

export interface TrashListResult {
  items: TrashItem[];
  hasMore: boolean;
  metrics: WorkspaceMetrics;
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

export type MailboxFilter = 'all' | 'unread' | 'starred';

export interface MailboxPage {
  folder: MailboxSection;
  messages: MailMessage[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  query: string;
  filter: MailboxFilter;
  deliveryStatus: DeliveryStatus | null;
  /** Exact match count for the first page of a server-side search. */
  searchTotal?: number;
  searchHitFields?: MailSearchHitField[];
  metrics?: WorkspaceMetrics;
}

/** The single workspace contract returned by SSR and session APIs. */
export interface WorkspaceSnapshot extends WorkspacePayload {
  activeFolder: MailboxSection;
  activePage: MailboxPage;
  mailboxPages: Partial<Record<MailboxSection, MailboxPage>>;
  /** Effective envelope sender configured for outbound delivery. */
  outboundSenderEmail: string | null;
}

export interface MailboxMessageSummary {
  id: string;
  folder: Exclude<MailFolder, 'drafts'>;
  source: MailSource;
  threadKey: string | null;
  read: boolean;
  starred: boolean;
  archivedAt: string | null;
}

export interface MailboxMovement {
  id: string;
  from: 'inbox' | 'archive';
  to: 'inbox' | 'archive';
}

export interface MailboxMutationResult {
  summaries: MailboxMessageSummary[];
  metrics: WorkspaceMetrics;
  movement: MailboxMovement[];
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
  expectedUpdatedAt?: string;
  /** Opaque pointer proving that the editor loaded the canonical draft body. */
  bodyRevision?: string;
  overwrite?: boolean;
  saveAsCopy?: boolean;
  /** New payload shape. Strings are accepted only as a legacy compatibility input. */
  to?: MailAddressInput[] | string;
  cc?: MailAddressInput[] | string;
  bcc?: MailAddressInput[] | string;
  /** Legacy payload fields retained for old drafts and clients. */
  toEmail?: string;
  /** Metadata only. Attachment bytes are always uploaded directly to R2. */
  attachments?: MailAttachmentSummary[];
  /** Client-only source choices shown before original forward attachments are re-uploaded. */
  forwardAttachmentCandidates?: MailAttachmentSummary[];
  /** Optimistic concurrency token for the draft attachment relation. */
  attachmentRevision?: number;
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
  to?: MailAddressInput[] | string;
  cc?: MailAddressInput[] | string;
  bcc?: MailAddressInput[] | string;
  toEmail?: string;
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
  return {
    ...message,
    labels: [...message.labels],
    toAddresses: message.toAddresses?.map((address) => ({ ...address })),
    ccAddresses: message.ccAddresses?.map((address) => ({ ...address })),
    bccAddresses: message.bccAddresses?.map((address) => ({ ...address }))
  };
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
    draftsCount: mailbox.drafts.length,
    trashCount: 0,
    queuedCount: mailbox.sent.filter((message) => message.deliveryStatus === 'queued' || message.deliveryStatus === 'submitting').length,
    delayedCount: mailbox.sent.filter((message) => message.deliveryStatus === 'delayed').length,
    failedCount: mailbox.sent.filter((message) => message.deliveryStatus === 'failed' || message.deliveryStatus === 'suppressed').length,
    bouncedCount: mailbox.sent.filter((message) => message.deliveryStatus === 'bounced').length,
    complainedCount: mailbox.sent.filter((message) => message.deliveryStatus === 'complained').length,
    staleDeliveryCount: 0
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
