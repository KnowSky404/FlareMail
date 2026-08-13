import {
  cloneMailbox,
  cloneMessage,
  cloneProfile,
  createDraftMessage,
  createSentMessage,
  createWorkspacePayload,
  type ComposeInput,
  type DeliveryDetail,
  type DeliveryEvent,
  type DeliveryEventType,
  type DeliveryResultKind,
  type DeliveryStatus,
  type MailFolder,
  type MailboxState,
  type MailMessage,
  type MessagePatch,
  type UserProfile,
  type WorkspacePayload
} from '$lib/domain/mail';
import { fromInboundMessageId, isInboundMessageId, toInboundMessageId } from '$lib/domain/mail';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import type { OutboundDeliveryState } from '$lib/server/outbound';

export { cloneMailbox, cloneMessage, cloneProfile, createDraftMessage, createSentMessage, createWorkspacePayload };
export { fromInboundMessageId, isInboundMessageId, toInboundMessageId };
export type {
  ComposeInput,
  DeliveryDetail,
  DeliveryEvent,
  DeliveryEventType,
  DeliveryResultKind,
  DeliveryStatus,
  MailFolder,
  MailboxState,
  MailMessage,
  MessagePatch,
  UserProfile,
  WorkspacePayload
};

export const demoCredentials = {
  email: 'founder@flaremail.dev',
  password: 'flaremail-demo'
} as const;

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

export const workspaceSessionCookie = 'flaremail_workspace';

export interface WorkspaceCapabilities {
  drafts: boolean;
  inboundStates: boolean;
  outboundStatuses: boolean;
  outboundReceipts: boolean;
  outboundEvents: boolean;
}

export interface WorkspaceSession {
  id: string;
  userId: string;
  profile: UserProfile;
  mailbox: MailboxState;
  incomingSequence: number;
  createdAt: string;
  updatedAt: string;
  storage: 'memory' | 'd1';
}

export interface WorkspaceUserRow {
  id: string;
  login_email: string;
  name: string;
  role: string;
  email: string;
  company: string;
  location: string;
  timezone: string;
  forwarding_enabled: number;
  signature: string;
  incoming_sequence: number;
}

export interface WorkspaceSessionJoinRow extends WorkspaceUserRow {
  session_id: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMessageRow {
  id: string;
  folder: Exclude<MailFolder, 'drafts'>;
  from_name: string;
  from_email: string;
  to_name: string;
  to_email: string;
  subject: string;
  preview: string;
  body: string;
  sent_at: string;
  labels_json: string;
  is_read: number;
  is_starred: number;
}

export interface WorkspaceDraftRow {
  id: string;
  to_email: string;
  cc: string;
  subject: string;
  body: string;
  is_starred: number;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceInboundRow {
  email_id: string;
  from: string;
  to: string;
  subject: string;
  timestamp: string;
  snippet: string;
  is_read: number;
  is_starred: number;
}

export interface WorkspaceOutboundStatusRow {
  message_id: string;
  status: DeliveryStatus;
  attempts: number;
  delivered_at: string | null;
  last_error: string;
  provider_message_id: string | null;
  provider: string | null;
  result_kind: DeliveryResultKind | null;
  remote_status: number | null;
  response_preview: string;
  last_event: DeliveryEventType | null;
  last_event_at: string | null;
}

export interface WorkspaceOutboundReceiptRow {
  provider: string | null;
  result_kind: DeliveryResultKind | null;
  remote_status: number | null;
  response_preview: string;
  last_event: DeliveryEventType | null;
  last_event_at: string | null;
}

export interface WorkspaceOutboundEventRow {
  svix_id: string;
  event_type: DeliveryEventType;
  event_created_at: string;
  summary: string;
  payload_json: string;
}

export const legacySeedMessageIds = ['inbox-01', 'inbox-02', 'inbox-03', 'sent-01', 'sent-02'] as const;
export const legacySeedSentIds = ['sent-01', 'sent-02'] as const;
export const legacySeedDraftIds = ['draft-01'] as const;
export const legacyProfileMatch = {
  name: 'Evelyn Chen',
  role: 'Founder, FlareMail',
  email: demoCredentials.email,
  company: 'FlareMail Labs',
  location: 'Shanghai',
  timezone: 'Asia/Shanghai',
  forwardingEnabled: true,
  signature: 'Regards,\nEvelyn\nFlareMail'
} as const;

export const nowIso = () => new Date().toISOString();

export function parseLabels(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export const sortMessages = (messages: MailMessage[]) =>
  [...messages].sort((left, right) => right.sentAt.localeCompare(left.sentAt) || right.id.localeCompare(left.id));

export const deriveNameFromEmail = (email: string) =>
  email.split('@')[0].replace(/[._-]/g, ' ').trim() || email.trim();

export function parseAddress(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^(?:"?([^\"]+)"?\s*)?<([^>]+)>$/);
  if (match) {
    const email = match[2].trim();
    return { name: match[1]?.trim() || deriveNameFromEmail(email), email };
  }
  return { name: deriveNameFromEmail(trimmed), email: trimmed };
}

export const mapUserRowToProfile = (row: WorkspaceUserRow): UserProfile => ({
  name: row.name,
  role: row.role,
  email: row.email,
  company: row.company,
  location: row.location,
  timezone: row.timezone,
  forwardingEnabled: Boolean(row.forwarding_enabled),
  signature: row.signature
});

export const mapWorkspaceMessageRow = (
  row: WorkspaceMessageRow,
  outboundStatus?: WorkspaceOutboundStatusRow
): MailMessage => ({
  id: row.id,
  folder: row.folder,
  source: 'workspace',
  fromName: row.from_name,
  fromEmail: row.from_email,
  toName: row.to_name,
  toEmail: row.to_email,
  subject: row.subject,
  preview: row.preview,
  body: row.body,
  sentAt: row.sent_at,
  labels: parseLabels(row.labels_json),
  read: Boolean(row.is_read),
  starred: Boolean(row.is_starred),
  deliveryStatus: row.folder === 'sent' ? outboundStatus?.status ?? null : null,
  deliveryAttempts: row.folder === 'sent' ? outboundStatus?.attempts ?? 0 : 0,
  deliveryError: row.folder === 'sent' ? outboundStatus?.last_error ?? '' : '',
  deliveredAt: row.folder === 'sent' ? outboundStatus?.delivered_at ?? null : null,
  deliveryProvider: row.folder === 'sent' ? outboundStatus?.provider ?? null : null,
  deliveryResultKind: row.folder === 'sent' ? outboundStatus?.result_kind ?? null : null,
  deliveryRemoteStatus: row.folder === 'sent' ? outboundStatus?.remote_status ?? null : null,
  deliveryResponsePreview: row.folder === 'sent' ? outboundStatus?.response_preview ?? '' : '',
  deliveryLastEvent: row.folder === 'sent' ? outboundStatus?.last_event ?? null : null,
  deliveryLastEventAt: row.folder === 'sent' ? outboundStatus?.last_event_at ?? null : null
});

export const mapDraftRow = (row: WorkspaceDraftRow, profile: UserProfile): MailMessage =>
  createDraftMessage({
    id: row.id,
    from: profile,
    toEmail: row.to_email,
    cc: row.cc,
    subject: row.subject,
    body: row.body,
    starred: Boolean(row.is_starred),
    updatedAt: row.updated_at || row.created_at
  });

export function mapInboundRow(row: WorkspaceInboundRow, profile: UserProfile): MailMessage {
  const sender = parseAddress(row.from);
  const recipient = parseAddress(row.to || profile.email);
  const snippet = row.snippet.trim() || '原始邮件已写入 R2，后续可以补充正文解析与预览。';
  return {
    id: `email:${row.email_id}`,
    folder: 'inbox',
    source: 'inbound',
    fromName: sender.name,
    fromEmail: sender.email,
    toName: recipient.name || profile.name,
    toEmail: recipient.email || profile.email,
    subject: row.subject || '(no subject)',
    preview: snippet,
    body: `${snippet}\n\n原始邮件已存储在 R2。后续可以在这里接入 EML 解析、附件列表和完整正文查看。`,
    sentAt: row.timestamp,
    labels: ['Inbound', 'Cloudflare'],
    read: Boolean(row.is_read),
    starred: Boolean(row.is_starred)
  };
}

export function rowsToMailbox(
  rows: WorkspaceMessageRow[],
  draftRows: WorkspaceDraftRow[],
  inboundRows: WorkspaceInboundRow[],
  outboundRows: WorkspaceOutboundStatusRow[],
  profile: UserProfile
): MailboxState {
  const outboundByMessageId = new Map(outboundRows.map((row) => [row.message_id, row]));
  const mailbox: MailboxState = { inbox: [], sent: [], drafts: [] };
  for (const row of rows) {
    const message = mapWorkspaceMessageRow(row, outboundByMessageId.get(row.id));
    mailbox[message.folder].push(message);
  }
  for (const row of draftRows) mailbox.drafts.push(mapDraftRow(row, profile));
  for (const row of inboundRows) mailbox.inbox.push(mapInboundRow(row, profile));
  mailbox.inbox = sortMessages(mailbox.inbox);
  mailbox.sent = sortMessages(mailbox.sent);
  mailbox.drafts = sortMessages(mailbox.drafts);
  return mailbox;
}

export const normalizeProfile = (profile: UserProfile): UserProfile => ({
  name: profile.name.trim(), role: profile.role.trim(), email: profile.email.trim(), company: profile.company.trim(),
  location: profile.location.trim(), timezone: profile.timezone.trim(), forwardingEnabled: profile.forwardingEnabled,
  signature: profile.signature.trim()
});

export const normalizePatch = (message: MailMessage, patch: MessagePatch): MailMessage => ({
  ...cloneMessage(message), read: patch.read ?? message.read, starred: patch.starred ?? message.starred
});

export const cloneSession = (session: WorkspaceSession): WorkspaceSession => ({
  ...session, profile: cloneProfile(session.profile), mailbox: cloneMailbox(session.mailbox)
});

export function createMemoryWorkspaceSession(): WorkspaceSession {
  const now = nowIso();
  return {
    id: crypto.randomUUID(), userId: 'memory-demo-user', profile: cloneProfile(), mailbox: cloneMailbox(),
    incomingSequence: 0, createdAt: now, updatedAt: now, storage: 'memory'
  };
}

export const serializeWorkspace = (session: WorkspaceSession): WorkspacePayload =>
  createWorkspacePayload(session.profile, session.mailbox);

export const findMessage = (session: WorkspaceSession, messageId: string) =>
  session.mailbox.inbox.find((message) => message.id === messageId) ??
  session.mailbox.sent.find((message) => message.id === messageId) ??
  session.mailbox.drafts.find((message) => message.id === messageId) ?? null;

export function memoryDeliveryDetail(message: MailMessage): DeliveryDetail {
  const eventType = message.deliveryLastEvent ?? 'submission';
  const createdAt = message.deliveryLastEventAt ?? message.deliveredAt ?? message.sentAt;
  return {
    messageId: message.id, provider: message.deliveryProvider ?? 'demo', resultKind: message.deliveryResultKind ?? null,
    lastEvent: eventType, lastEventAt: createdAt,
    events: [{
      id: `local:${message.id}:${eventType}`, type: eventType, createdAt,
      summary: message.deliveryResponsePreview || message.deliveryError || '这封邮件已经写入当前工作台的出站投递记录。',
      payloadPreview: JSON.stringify({ provider: message.deliveryProvider ?? 'demo', resultKind: message.deliveryResultKind ?? null, status: message.deliveryStatus ?? null })
    }]
  };
}

export function serializeMessageForInsert(userId: string, message: MailMessage) {
  const timestamp = nowIso();
  return { userId, id: message.id, folder: message.folder, fromName: message.fromName, fromEmail: message.fromEmail,
    toName: message.toName, toEmail: message.toEmail, subject: message.subject, preview: message.preview, body: message.body,
    sentAt: message.sentAt, labelsJson: JSON.stringify(message.labels), isRead: message.read ? 1 : 0,
    isStarred: message.starred ? 1 : 0, createdAt: timestamp, updatedAt: timestamp };
}

export function serializeDraftForInsert(userId: string, input: ComposeInput, starred: boolean) {
  const timestamp = nowIso();
  return { userId, id: input.draftId ?? `draft-live-${crypto.randomUUID()}`, toEmail: input.toEmail.trim(),
    cc: input.cc?.trim() ?? '', subject: input.subject.trim(), body: input.body.trim(), isStarred: starred ? 1 : 0,
    createdAt: timestamp, updatedAt: timestamp };
}

export function serializeOutboundStatusForUpsert(userId: string, messageId: string, state: OutboundDeliveryState) {
  const timestamp = nowIso();
  return { messageId, userId, status: state.status, attempts: state.attempts, deliveredAt: state.deliveredAt,
    lastError: state.lastError, providerMessageId: state.providerMessageId, createdAt: timestamp, updatedAt: timestamp };
}

export function serializeOutboundReceiptForUpsert(userId: string, messageId: string, state: OutboundDeliveryState) {
  const timestamp = state.deliveredAt ?? nowIso();
  return { messageId, userId, provider: state.provider, resultKind: state.resultKind, remoteStatus: state.remoteStatus,
    responsePreview: state.responsePreview, lastEvent: 'submission' as const, lastEventAt: timestamp, createdAt: timestamp, updatedAt: timestamp };
}

export function serializeOutboundEventInsert(input: {
  svixId: string; messageId: string; userId: string; provider: string; providerMessageId?: string | null;
  eventType: DeliveryEventType; eventCreatedAt: string; summary: string; payloadJson: string;
}) { return { ...input, createdAt: nowIso() }; }

export const mapEventRowToDeliveryEvent = (row: WorkspaceOutboundEventRow): DeliveryEvent => ({
  id: row.svix_id, type: row.event_type, createdAt: row.event_created_at, summary: row.summary, payloadPreview: row.payload_json
});

export function touchMemorySession(session: WorkspaceSession) {
  session.updatedAt = nowIso();
  return session;
}

export type WorkspaceEnv = CloudflareEnv | undefined;
