import type { Cookies } from '@sveltejs/kit';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { deliverOutboundMessage, type OutboundDeliveryState } from '$lib/server/outbound';
import { normalizeResendWebhookEvent } from '$lib/server/resend-webhook';
import {
  cloneMailbox,
  cloneProfile,
  createDraftMessage,
  createSentMessage,
  createWorkspacePayload,
  demoCredentials,
  type DeliveryDetail,
  type DeliveryEvent,
  type DeliveryEventType,
  type DeliveryStatus,
  type DeliveryResultKind,
  fromInboundMessageId,
  isInboundMessageId,
  mockProfile,
  toInboundMessageId,
  type ComposeInput,
  type MailFolder,
  type MailMessage,
  type MailboxState,
  type MessagePatch,
  type UserProfile,
  type WorkspacePayload
} from '$lib/mock/mailbox';

export const workspaceSessionCookie = 'flaremail_workspace';
type CookieOptions = Parameters<Cookies['set']>[2];

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

type WorkspaceCapabilities = {
  drafts: boolean;
  inboundStates: boolean;
  outboundStatuses: boolean;
  outboundReceipts: boolean;
  outboundEvents: boolean;
};

type WorkspaceUserRow = {
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
};

type WorkspaceSessionJoinRow = WorkspaceUserRow & {
  session_id: string;
  created_at: string;
  updated_at: string;
};

type WorkspaceMessageRow = {
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
};

type WorkspaceDraftRow = {
  id: string;
  to_email: string;
  cc: string;
  subject: string;
  body: string;
  is_starred: number;
  created_at: string;
  updated_at: string;
};

type WorkspaceInboundRow = {
  email_id: string;
  from: string;
  to: string;
  subject: string;
  timestamp: string;
  snippet: string;
  is_read: number;
  is_starred: number;
};

type WorkspaceOutboundStatusRow = {
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
};

type WorkspaceOutboundReceiptRow = {
  provider: string | null;
  result_kind: DeliveryResultKind | null;
  remote_status: number | null;
  response_preview: string;
  last_event: DeliveryEventType | null;
  last_event_at: string | null;
};

type WorkspaceOutboundEventRow = {
  svix_id: string;
  event_type: DeliveryEventType;
  event_created_at: string;
  summary: string;
  payload_json: string;
};

const memorySessions = new Map<string, WorkspaceSession>();
const legacySeedMessageIds = ['inbox-01', 'inbox-02', 'inbox-03', 'sent-01', 'sent-02'] as const;
const legacySeedSentIds = ['sent-01', 'sent-02'] as const;
const legacySeedDraftIds = ['draft-01'] as const;
const legacyProfileMatch = {
  name: 'Evelyn Chen',
  role: 'Founder, FlareMail',
  email: demoCredentials.email,
  company: 'FlareMail Labs',
  location: 'Shanghai',
  timezone: 'Asia/Shanghai',
  forwardingEnabled: true,
  signature: 'Regards,\nEvelyn\nFlareMail'
} as const;

const cloneMessage = (message: MailMessage): MailMessage => ({
  ...message,
  labels: [...message.labels]
});

const nowIso = () => new Date().toISOString();

const parseLabels = (value: string) => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

const sortMessages = (messages: MailMessage[]) =>
  [...messages].sort((left, right) => right.sentAt.localeCompare(left.sentAt) || right.id.localeCompare(left.id));

const deriveNameFromEmail = (email: string) =>
  email.split('@')[0].replace(/[._-]/g, ' ').trim() || email.trim();

const parseAddress = (value: string) => {
  const trimmed = value.trim();
  const match = trimmed.match(/^(?:"?([^"]+)"?\s*)?<([^>]+)>$/);

  if (match) {
    const name = match[1]?.trim();
    const email = match[2].trim();
    return {
      name: name || deriveNameFromEmail(email),
      email
    };
  }

  return {
    name: deriveNameFromEmail(trimmed),
    email: trimmed
  };
};

const mapUserRowToProfile = (row: WorkspaceUserRow): UserProfile => ({
  name: row.name,
  role: row.role,
  email: row.email,
  company: row.company,
  location: row.location,
  timezone: row.timezone,
  forwardingEnabled: Boolean(row.forwarding_enabled),
  signature: row.signature
});

const mapWorkspaceMessageRow = (
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

const mapDraftRow = (row: WorkspaceDraftRow, profile: UserProfile): MailMessage =>
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

const mapInboundRow = (row: WorkspaceInboundRow, profile: UserProfile): MailMessage => {
  const sender = parseAddress(row.from);
  const recipient = parseAddress(row.to || profile.email);
  const snippet = row.snippet.trim() || '原始邮件已写入 R2，后续可以补充正文解析与预览。';

  return {
    id: toInboundMessageId(row.email_id),
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
};

const isLegacySeedProfile = (row: WorkspaceUserRow) =>
  row.name === legacyProfileMatch.name &&
  row.role === legacyProfileMatch.role &&
  row.email === legacyProfileMatch.email &&
  row.company === legacyProfileMatch.company &&
  row.location === legacyProfileMatch.location &&
  row.timezone === legacyProfileMatch.timezone &&
  Boolean(row.forwarding_enabled) === legacyProfileMatch.forwardingEnabled &&
  row.signature === legacyProfileMatch.signature;

async function cleanupLegacyWorkspaceSeedData(
  db: D1Database,
  userId: string,
  capabilities: WorkspaceCapabilities
) {
  const statements = [
    db.prepare(
      `
        DELETE FROM workspace_messages
        WHERE user_id = ?
          AND (
            id IN (?, ?, ?, ?, ?)
            OR id LIKE 'inbox-live-%'
          )
      `
    ).bind(userId, ...legacySeedMessageIds)
  ];

  if (capabilities.drafts) {
    statements.push(
      db.prepare(
        `
          DELETE FROM workspace_drafts
          WHERE user_id = ?
            AND id = ?
        `
      ).bind(userId, ...legacySeedDraftIds)
    );
  }

  if (capabilities.outboundStatuses) {
    statements.push(
      db.prepare(
        `
          DELETE FROM workspace_outbound_statuses
          WHERE user_id = ?
            AND message_id IN (?, ?)
        `
      ).bind(userId, ...legacySeedSentIds)
    );
  }

  if (capabilities.outboundReceipts) {
    statements.push(
      db.prepare(
        `
          DELETE FROM workspace_outbound_receipts
          WHERE user_id = ?
            AND message_id IN (?, ?)
        `
      ).bind(userId, ...legacySeedSentIds)
    );
  }

  if (capabilities.outboundEvents) {
    statements.push(
      db.prepare(
        `
          DELETE FROM workspace_outbound_events
          WHERE user_id = ?
            AND message_id IN (?, ?)
        `
      ).bind(userId, ...legacySeedSentIds)
    );
  }

  await db.batch(statements);
}

async function normalizeLegacyDemoUserProfile(db: D1Database, user: WorkspaceUserRow) {
  if (!isLegacySeedProfile(user)) {
    return user;
  }

  const profile = mockProfile;
  const updatedAt = nowIso();

  await db.prepare(
    `
      UPDATE workspace_users
      SET
        name = ?,
        role = ?,
        email = ?,
        company = ?,
        location = ?,
        timezone = ?,
        forwarding_enabled = ?,
        signature = ?,
        updated_at = ?
      WHERE id = ?
    `
  ).bind(
    profile.name,
    profile.role,
    profile.email,
    profile.company,
    profile.location,
    profile.timezone,
    profile.forwardingEnabled ? 1 : 0,
    profile.signature,
    updatedAt,
    user.id
  ).run();

  return {
    ...user,
    name: profile.name,
    role: profile.role,
    email: profile.email,
    company: profile.company,
    location: profile.location,
    timezone: profile.timezone,
    forwarding_enabled: profile.forwardingEnabled ? 1 : 0,
    signature: profile.signature
  };
}

const rowsToMailbox = (
  rows: WorkspaceMessageRow[],
  draftRows: WorkspaceDraftRow[],
  inboundRows: WorkspaceInboundRow[],
  outboundRows: WorkspaceOutboundStatusRow[],
  profile: UserProfile
): MailboxState => {
  const outboundByMessageId = new Map(outboundRows.map((row) => [row.message_id, row]));
  const mailbox: MailboxState = {
    inbox: [],
    sent: [],
    drafts: []
  };

  for (const row of rows) {
    const message = mapWorkspaceMessageRow(row, outboundByMessageId.get(row.id));
    mailbox[message.folder].push(message);
  }

  for (const row of draftRows) {
    mailbox.drafts.push(mapDraftRow(row, profile));
  }

  for (const row of inboundRows) {
    mailbox.inbox.push(mapInboundRow(row, profile));
  }

  mailbox.inbox = sortMessages(mailbox.inbox);
  mailbox.sent = sortMessages(mailbox.sent);
  mailbox.drafts = sortMessages(mailbox.drafts);
  return mailbox;
};

const normalizeProfile = (profile: UserProfile): UserProfile => ({
  name: profile.name.trim(),
  role: profile.role.trim(),
  email: profile.email.trim(),
  company: profile.company.trim(),
  location: profile.location.trim(),
  timezone: profile.timezone.trim(),
  forwardingEnabled: profile.forwardingEnabled,
  signature: profile.signature.trim()
});

const normalizePatch = (message: MailMessage, patch: MessagePatch): MailMessage => ({
  ...cloneMessage(message),
  read: patch.read ?? message.read,
  starred: patch.starred ?? message.starred
});

const cloneSession = (session: WorkspaceSession): WorkspaceSession => ({
  ...session,
  profile: cloneProfile(session.profile),
  mailbox: cloneMailbox(session.mailbox)
});

function createMemoryWorkspaceSession(): WorkspaceSession {
  const now = nowIso();

  return {
    id: crypto.randomUUID(),
    userId: 'memory-demo-user',
    profile: cloneProfile(),
    mailbox: cloneMailbox(),
    incomingSequence: 0,
    createdAt: now,
    updatedAt: now,
    storage: 'memory'
  };
}

function touchMemorySession(session: WorkspaceSession) {
  session.updatedAt = nowIso();
  return session;
}

function serializeMessageForInsert(userId: string, message: MailMessage) {
  const timestamp = nowIso();

  return {
    userId,
    id: message.id,
    folder: message.folder,
    fromName: message.fromName,
    fromEmail: message.fromEmail,
    toName: message.toName,
    toEmail: message.toEmail,
    subject: message.subject,
    preview: message.preview,
    body: message.body,
    sentAt: message.sentAt,
    labelsJson: JSON.stringify(message.labels),
    isRead: message.read ? 1 : 0,
    isStarred: message.starred ? 1 : 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function serializeDraftForInsert(userId: string, input: ComposeInput, starred: boolean) {
  const timestamp = nowIso();

  return {
    userId,
    id: input.draftId ?? `draft-live-${crypto.randomUUID()}`,
    toEmail: input.toEmail.trim(),
    cc: input.cc?.trim() ?? '',
    subject: input.subject.trim(),
    body: input.body.trim(),
    isStarred: starred ? 1 : 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function serializeOutboundStatusForUpsert(
  userId: string,
  messageId: string,
  state: OutboundDeliveryState
) {
  const timestamp = nowIso();

  return {
    messageId,
    userId,
    status: state.status,
    attempts: state.attempts,
    deliveredAt: state.deliveredAt,
    lastError: state.lastError,
    providerMessageId: state.providerMessageId,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function serializeOutboundReceiptForUpsert(
  userId: string,
  messageId: string,
  state: OutboundDeliveryState
) {
  const timestamp = state.deliveredAt ?? nowIso();

  return {
    messageId,
    userId,
    provider: state.provider,
    resultKind: state.resultKind,
    remoteStatus: state.remoteStatus,
    responsePreview: state.responsePreview,
    lastEvent: 'submission',
    lastEventAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function serializeOutboundEventInsert(input: {
  svixId: string;
  messageId: string;
  userId: string;
  provider: string;
  providerMessageId?: string | null;
  eventType: DeliveryEventType;
  eventCreatedAt: string;
  summary: string;
  payloadJson: string;
}) {
  return {
    ...input,
    createdAt: nowIso()
  };
}

function mapEventRowToDeliveryEvent(row: WorkspaceOutboundEventRow): DeliveryEvent {
  return {
    id: row.svix_id,
    type: row.event_type,
    createdAt: row.event_created_at,
    summary: row.summary,
    payloadPreview: row.payload_json
  };
}

async function hasNamedTables(db: D1Database, names: string[]) {
  const placeholders = names.map(() => '?').join(', ');
  const row = await db.prepare(
    `
      SELECT COUNT(*) AS total
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (${placeholders})
    `
  ).bind(...names).first<{ total: number }>();

  return (row?.total ?? 0) === names.length;
}

async function hasWorkspaceCoreTables(env?: CloudflareEnv) {
  if (!env?.DB) {
    return false;
  }

  try {
    return hasNamedTables(env.DB, ['workspace_users', 'workspace_sessions', 'workspace_messages']);
  } catch {
    return false;
  }
}

async function getWorkspaceCapabilities(env?: CloudflareEnv): Promise<WorkspaceCapabilities> {
  if (!env?.DB) {
    return {
      drafts: false,
      inboundStates: false,
      outboundStatuses: false,
      outboundReceipts: false,
      outboundEvents: false
    };
  }

  try {
    const [drafts, inboundStates, outboundStatuses, outboundReceipts, outboundEvents] = await Promise.all([
      hasNamedTables(env.DB, ['workspace_drafts']),
      hasNamedTables(env.DB, ['workspace_email_states']),
      hasNamedTables(env.DB, ['workspace_outbound_statuses']),
      hasNamedTables(env.DB, ['workspace_outbound_receipts']),
      hasNamedTables(env.DB, ['workspace_outbound_events'])
    ]);

    return {
      drafts,
      inboundStates,
      outboundStatuses,
      outboundReceipts,
      outboundEvents
    };
  } catch {
    return {
      drafts: false,
      inboundStates: false,
      outboundStatuses: false,
      outboundReceipts: false,
      outboundEvents: false
    };
  }
}

async function fetchD1Session(
  db: D1Database,
  sessionId: string,
  capabilities: WorkspaceCapabilities
) {
  const sessionRow = await db.prepare(
    `
      SELECT
        s.id AS session_id,
        s.created_at,
        s.updated_at,
        u.id,
        u.login_email,
        u.name,
        u.role,
        u.email,
        u.company,
        u.location,
        u.timezone,
        u.forwarding_enabled,
        u.signature,
        u.incoming_sequence
      FROM workspace_sessions AS s
      JOIN workspace_users AS u
        ON u.id = s.user_id
      WHERE s.id = ?
    `
  ).bind(sessionId).first<WorkspaceSessionJoinRow>();

  if (!sessionRow) {
    return null;
  }

  const profile = mapUserRowToProfile(sessionRow);
  const [messageRows, draftRows, inboundRows, outboundRows] = await Promise.all([
    db.prepare(
      `
        SELECT
          id,
          folder,
          from_name,
          from_email,
          to_name,
          to_email,
          subject,
          preview,
          body,
          sent_at,
          labels_json,
          is_read,
          is_starred
        FROM workspace_messages
        WHERE user_id = ?
        ORDER BY sent_at DESC, created_at DESC
      `
    ).bind(sessionRow.id).all<WorkspaceMessageRow>(),
    capabilities.drafts
      ? db.prepare(
          `
            SELECT
              id,
              to_email,
              cc,
              subject,
              body,
              is_starred,
              created_at,
              updated_at
            FROM workspace_drafts
            WHERE user_id = ?
            ORDER BY updated_at DESC, created_at DESC
          `
        ).bind(sessionRow.id).all<WorkspaceDraftRow>()
      : Promise.resolve({ results: [] as WorkspaceDraftRow[] }),
    capabilities.inboundStates
      ? db.prepare(
          `
            SELECT
              e.id AS email_id,
              e."from",
              e."to",
              e.subject,
              e."timestamp",
              e.snippet,
              COALESCE(s.is_read, 0) AS is_read,
              COALESCE(s.is_starred, 0) AS is_starred
            FROM email_messages AS e
            LEFT JOIN workspace_email_states AS s
              ON s.user_id = ?
             AND s.email_message_id = e.id
            WHERE lower(e."to") IN (lower(?), lower(?))
              AND s.deleted_at IS NULL
            ORDER BY e."timestamp" DESC, e.created_at DESC
          `
        ).bind(sessionRow.id, sessionRow.login_email, sessionRow.email).all<WorkspaceInboundRow>()
      : Promise.resolve({ results: [] as WorkspaceInboundRow[] }),
    capabilities.outboundStatuses
      ? capabilities.outboundReceipts
        ? db.prepare(
            `
              SELECT
                s.message_id,
                s.status,
                s.attempts,
                s.delivered_at,
                s.last_error,
                s.provider_message_id,
                r.provider,
                r.result_kind,
                r.remote_status,
                r.response_preview,
                r.last_event,
                r.last_event_at
              FROM workspace_outbound_statuses AS s
              LEFT JOIN workspace_outbound_receipts AS r
                ON r.message_id = s.message_id
               AND r.user_id = s.user_id
              WHERE s.user_id = ?
            `
          ).bind(sessionRow.id).all<WorkspaceOutboundStatusRow>()
        : db.prepare(
            `
              SELECT
                message_id,
                status,
                attempts,
                delivered_at,
                last_error,
                provider_message_id,
                NULL AS provider,
                NULL AS result_kind,
                NULL AS remote_status,
                '' AS response_preview,
                NULL AS last_event,
                NULL AS last_event_at
              FROM workspace_outbound_statuses
              WHERE user_id = ?
            `
          ).bind(sessionRow.id).all<WorkspaceOutboundStatusRow>()
      : Promise.resolve({ results: [] as WorkspaceOutboundStatusRow[] })
  ]);

  return {
    id: sessionRow.session_id,
    userId: sessionRow.id,
    profile,
    mailbox: rowsToMailbox(
      messageRows.results ?? [],
      draftRows.results ?? [],
      inboundRows.results ?? [],
      outboundRows.results ?? [],
      profile
    ),
    incomingSequence: sessionRow.incoming_sequence,
    createdAt: sessionRow.created_at,
    updatedAt: sessionRow.updated_at,
    storage: 'd1' as const
  };
}

async function ensureDemoUser(db: D1Database, capabilities: WorkspaceCapabilities) {
  let user = await db.prepare(
    `
      SELECT
        id,
        login_email,
        name,
        role,
        email,
        company,
        location,
        timezone,
        forwarding_enabled,
        signature,
        incoming_sequence
      FROM workspace_users
      WHERE login_email = ?
    `
  ).bind(demoCredentials.email).first<WorkspaceUserRow>();

  if (!user) {
    const userId = crypto.randomUUID();
    const profile = mockProfile;
    const timestamp = nowIso();

    await db.prepare(
      `
        INSERT INTO workspace_users (
          id,
          login_email,
          name,
          role,
          email,
          company,
          location,
          timezone,
          forwarding_enabled,
          signature,
          incoming_sequence,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).bind(
      userId,
      demoCredentials.email,
      profile.name,
      profile.role,
      profile.email,
      profile.company,
      profile.location,
      profile.timezone,
      profile.forwardingEnabled ? 1 : 0,
      profile.signature,
      0,
      timestamp,
      timestamp
    ).run();

    user = await db.prepare(
      `
        SELECT
          id,
          login_email,
          name,
          role,
          email,
          company,
          location,
          timezone,
          forwarding_enabled,
          signature,
          incoming_sequence
        FROM workspace_users
        WHERE id = ?
      `
    ).bind(userId).first<WorkspaceUserRow>();
  }

  if (!user) {
    throw new Error('无法初始化演示用户。');
  }

  user = await normalizeLegacyDemoUserProfile(db, user);
  await cleanupLegacyWorkspaceSeedData(db, user.id, capabilities);

  return user;
}

function findMessage(session: WorkspaceSession, messageId: string) {
  return (
    session.mailbox.inbox.find((message) => message.id === messageId) ??
    session.mailbox.sent.find((message) => message.id === messageId) ??
    session.mailbox.drafts.find((message) => message.id === messageId) ??
    null
  );
}

function buildMemoryDeliveryDetail(message: MailMessage): DeliveryDetail {
  const eventType = message.deliveryLastEvent ?? 'submission';
  const createdAt = message.deliveryLastEventAt ?? message.deliveredAt ?? message.sentAt;

  return {
    messageId: message.id,
    provider: message.deliveryProvider ?? 'demo',
    resultKind: message.deliveryResultKind ?? null,
    lastEvent: eventType,
    lastEventAt: createdAt,
    events: [
      {
        id: `local:${message.id}:${eventType}`,
        type: eventType,
        createdAt,
        summary:
          message.deliveryResponsePreview ||
          message.deliveryError ||
          '这封邮件已经写入当前工作台的出站投递记录。',
        payloadPreview: JSON.stringify({
          provider: message.deliveryProvider ?? 'demo',
          resultKind: message.deliveryResultKind ?? null,
          status: message.deliveryStatus ?? null
        })
      }
    ]
  };
}

async function fetchD1DeliveryDetail(
  db: D1Database,
  userId: string,
  messageId: string,
  capabilities: WorkspaceCapabilities
) {
  const [receipt, eventRows] = await Promise.all([
    capabilities.outboundReceipts
      ? db.prepare(
          `
            SELECT
              provider,
              result_kind,
              remote_status,
              response_preview,
              last_event,
              last_event_at
            FROM workspace_outbound_receipts
            WHERE user_id = ?
              AND message_id = ?
          `
        ).bind(userId, messageId).first<WorkspaceOutboundReceiptRow>()
      : Promise.resolve(null),
    capabilities.outboundEvents
      ? db.prepare(
          `
            SELECT
              svix_id,
              event_type,
              event_created_at,
              summary,
              payload_json
            FROM workspace_outbound_events
            WHERE user_id = ?
              AND message_id = ?
            ORDER BY event_created_at DESC, created_at DESC
          `
        ).bind(userId, messageId).all<WorkspaceOutboundEventRow>()
      : Promise.resolve({ results: [] as WorkspaceOutboundEventRow[] })
  ]);

  const events = (eventRows.results ?? []).map(mapEventRowToDeliveryEvent);

  if (!receipt && !events.length) {
    return null;
  }

  if (!events.length && receipt) {
    events.push({
      id: `local:${messageId}:${receipt.last_event ?? 'submission'}`,
      type: receipt.last_event ?? 'submission',
      createdAt: receipt.last_event_at ?? nowIso(),
      summary: receipt.response_preview || '这封邮件已经写入当前工作台的出站投递记录。',
      payloadPreview: JSON.stringify({
        provider: receipt.provider,
        resultKind: receipt.result_kind,
        remoteStatus: receipt.remote_status
      })
    });
  }

  return {
    messageId,
    provider: receipt?.provider ?? null,
    resultKind: receipt?.result_kind ?? null,
    lastEvent: receipt?.last_event ?? events[0]?.type ?? null,
    lastEventAt: receipt?.last_event_at ?? events[0]?.createdAt ?? null,
    events
  } satisfies DeliveryDetail;
}

export function serializeWorkspace(session: WorkspaceSession): WorkspacePayload {
  return createWorkspacePayload(session.profile, session.mailbox);
}

export async function getWorkspaceMessageDeliveryDetail(
  env: CloudflareEnv | undefined,
  session: WorkspaceSession,
  messageId: string
) {
  const message = findMessage(session, messageId);

  if (!message || message.folder !== 'sent' || message.source !== 'workspace') {
    return null;
  }

  if (session.storage === 'd1' && (await hasWorkspaceCoreTables(env))) {
    const capabilities = await getWorkspaceCapabilities(env);
    return fetchD1DeliveryDetail(env!.DB, session.userId, messageId, capabilities);
  }

  return buildMemoryDeliveryDetail(message);
}

export async function applyResendDeliveryWebhook(
  env: CloudflareEnv | undefined,
  svixId: string,
  payload: unknown
) {
  if (!env?.DB) {
    throw new Error('运行时缺少 D1 绑定。');
  }

  const capabilities = await getWorkspaceCapabilities(env);

  if (!capabilities.outboundStatuses || !capabilities.outboundReceipts || !capabilities.outboundEvents) {
    throw new Error('出站回执相关数据表尚未迁移，请先执行最新的 D1 schema。');
  }

  const event = normalizeResendWebhookEvent(payload as Parameters<typeof normalizeResendWebhookEvent>[0]);
  const existingEvent = await env.DB.prepare(
    `
      SELECT svix_id
      FROM workspace_outbound_events
      WHERE svix_id = ?
    `
  ).bind(svixId).first<{ svix_id: string }>();

  if (existingEvent) {
    return {
      duplicate: true,
      ignored: false,
      matched: true,
      messageId: null as string | null
    };
  }

  const outboundRow = await env.DB.prepare(
    `
      SELECT
        s.message_id,
        s.user_id,
        s.attempts,
        s.delivered_at,
        r.remote_status,
        r.last_event_at
      FROM workspace_outbound_statuses AS s
      LEFT JOIN workspace_outbound_receipts AS r
        ON r.message_id = s.message_id
       AND r.user_id = s.user_id
      WHERE s.provider_message_id = ?
    `
  ).bind(event.providerMessageId).first<{
    message_id: string;
    user_id: string;
    attempts: number;
    delivered_at: string | null;
    remote_status: number | null;
    last_event_at: string | null;
  }>();

  const eventRecord = serializeOutboundEventInsert({
    svixId,
    messageId: outboundRow?.message_id ?? event.providerMessageId,
    userId: outboundRow?.user_id ?? 'unmatched',
    provider: event.provider,
    providerMessageId: event.providerMessageId,
    eventType: event.eventType,
    eventCreatedAt: event.createdAt,
    summary: event.summary,
    payloadJson: event.payloadJson
  });

  if (!outboundRow) {
    await env.DB.prepare(
      `
        INSERT INTO workspace_outbound_events (
          svix_id,
          message_id,
          user_id,
          provider,
          provider_message_id,
          event_type,
          event_created_at,
          summary,
          payload_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).bind(
      eventRecord.svixId,
      eventRecord.messageId,
      eventRecord.userId,
      eventRecord.provider,
      eventRecord.providerMessageId,
      eventRecord.eventType,
      eventRecord.eventCreatedAt,
      eventRecord.summary,
      eventRecord.payloadJson,
      eventRecord.createdAt
    ).run();

    return {
      duplicate: false,
      ignored: true,
      matched: false,
      messageId: null as string | null
    };
  }

  const shouldUpdateCurrent =
    !outboundRow.last_event_at || event.createdAt >= outboundRow.last_event_at;
  const nextDeliveryState: OutboundDeliveryState = {
    provider: event.provider,
    resultKind: event.resultKind,
    status: event.status,
    attempts: outboundRow.attempts,
    deliveredAt: event.deliveredAt ?? outboundRow.delivered_at,
    lastError: event.lastError,
    providerMessageId: event.providerMessageId,
    remoteStatus: outboundRow.remote_status,
    responsePreview: event.responsePreview
  };
  const statements = [
    env.DB.prepare(
      `
        INSERT INTO workspace_outbound_events (
          svix_id,
          message_id,
          user_id,
          provider,
          provider_message_id,
          event_type,
          event_created_at,
          summary,
          payload_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).bind(
      eventRecord.svixId,
      eventRecord.messageId,
      eventRecord.userId,
      eventRecord.provider,
      eventRecord.providerMessageId,
      eventRecord.eventType,
      eventRecord.eventCreatedAt,
      eventRecord.summary,
      eventRecord.payloadJson,
      eventRecord.createdAt
    )
  ];

  if (shouldUpdateCurrent) {
    const status = serializeOutboundStatusForUpsert(outboundRow.user_id, outboundRow.message_id, nextDeliveryState);
    const receipt = {
      ...serializeOutboundReceiptForUpsert(outboundRow.user_id, outboundRow.message_id, nextDeliveryState),
      lastEvent: event.eventType,
      lastEventAt: event.createdAt,
      remoteStatus: outboundRow.remote_status,
      responsePreview: event.responsePreview
    };

    statements.push(
      env.DB.prepare(
        `
          INSERT INTO workspace_outbound_statuses (
            message_id,
            user_id,
            status,
            attempts,
            delivered_at,
            last_error,
            provider_message_id,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(message_id) DO UPDATE SET
            status = excluded.status,
            attempts = excluded.attempts,
            delivered_at = excluded.delivered_at,
            last_error = excluded.last_error,
            provider_message_id = excluded.provider_message_id,
            updated_at = excluded.updated_at
        `
      ).bind(
        status.messageId,
        status.userId,
        status.status,
        status.attempts,
        status.deliveredAt,
        status.lastError,
        status.providerMessageId,
        status.createdAt,
        event.createdAt
      ),
      env.DB.prepare(
        `
          INSERT INTO workspace_outbound_receipts (
            message_id,
            user_id,
            provider,
            result_kind,
            remote_status,
            response_preview,
            last_event,
            last_event_at,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(message_id) DO UPDATE SET
            provider = excluded.provider,
            result_kind = excluded.result_kind,
            remote_status = excluded.remote_status,
            response_preview = excluded.response_preview,
            last_event = excluded.last_event,
            last_event_at = excluded.last_event_at,
            updated_at = excluded.updated_at
        `
      ).bind(
        receipt.messageId,
        receipt.userId,
        receipt.provider,
        receipt.resultKind,
        receipt.remoteStatus,
        receipt.responsePreview,
        receipt.lastEvent,
        receipt.lastEventAt,
        receipt.createdAt,
        event.createdAt
      )
    );
  }

  await env.DB.batch(statements);

  return {
    duplicate: false,
    ignored: !shouldUpdateCurrent,
    matched: true,
    messageId: outboundRow.message_id
  };
}

export async function getWorkspaceSession(env: CloudflareEnv | undefined, sessionId?: string | null) {
  if (!sessionId) {
    return null;
  }

  if (await hasWorkspaceCoreTables(env)) {
    const capabilities = await getWorkspaceCapabilities(env);
    const d1Session = await fetchD1Session(env!.DB, sessionId, capabilities);

    if (d1Session) {
      return d1Session;
    }
  }

  return memorySessions.get(sessionId) ?? null;
}

export async function authenticateWorkspaceUser(
  env: CloudflareEnv | undefined,
  email: string,
  password: string
) {
  if (email.trim() !== demoCredentials.email || password.trim() !== demoCredentials.password) {
    return null;
  }

  if (await hasWorkspaceCoreTables(env)) {
    const capabilities = await getWorkspaceCapabilities(env);
    const user = await ensureDemoUser(env!.DB, capabilities);
    const sessionId = crypto.randomUUID();
    const timestamp = nowIso();

    await env!.DB.prepare(
      `
        INSERT INTO workspace_sessions (id, user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `
    ).bind(sessionId, user.id, timestamp, timestamp).run();

    return fetchD1Session(env!.DB, sessionId, capabilities);
  }

  const session = createMemoryWorkspaceSession();
  memorySessions.set(session.id, session);
  return cloneSession(session);
}

export async function destroyWorkspaceSession(
  env: CloudflareEnv | undefined,
  sessionId?: string | null
) {
  if (!sessionId) {
    return;
  }

  memorySessions.delete(sessionId);

  if (await hasWorkspaceCoreTables(env)) {
    await env!.DB.prepare(
      `
        DELETE FROM workspace_sessions
        WHERE id = ?
      `
    ).bind(sessionId).run();
  }
}

export function sessionCookieOptions(remember: boolean): CookieOptions {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: remember ? 60 * 60 * 24 * 7 : undefined
  };
}

export function clearSessionCookieOptions(): CookieOptions {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 0
  };
}

async function refreshD1Session(env: CloudflareEnv | undefined, sessionId: string) {
  if (!(await hasWorkspaceCoreTables(env))) {
    return null;
  }

  const capabilities = await getWorkspaceCapabilities(env);
  return fetchD1Session(env!.DB, sessionId, capabilities);
}

export async function updateWorkspaceProfile(
  env: CloudflareEnv | undefined,
  session: WorkspaceSession,
  nextProfile: UserProfile
) {
  const profile = normalizeProfile(nextProfile);

  if (session.storage === 'd1' && (await hasWorkspaceCoreTables(env))) {
    await env!.DB.prepare(
      `
        UPDATE workspace_users
        SET
          name = ?,
          role = ?,
          email = ?,
          company = ?,
          location = ?,
          timezone = ?,
          forwarding_enabled = ?,
          signature = ?,
          updated_at = ?
        WHERE id = ?
      `
    ).bind(
      profile.name,
      profile.role,
      profile.email,
      profile.company,
      profile.location,
      profile.timezone,
      profile.forwardingEnabled ? 1 : 0,
      profile.signature,
      nowIso(),
      session.userId
    ).run();

    const nextSession = await refreshD1Session(env, session.id);

    if (!nextSession) {
      throw new Error('保存资料后无法重新加载工作区。');
    }

    return serializeWorkspace(nextSession);
  }

  session.profile = profile;
  touchMemorySession(session);
  memorySessions.set(session.id, cloneSession(session));
  return serializeWorkspace(session);
}

export async function saveWorkspaceDraft(
  env: CloudflareEnv | undefined,
  session: WorkspaceSession,
  input: ComposeInput
) {
  const currentDraft = input.draftId
    ? session.mailbox.drafts.find((message) => message.id === input.draftId) ?? null
    : null;

  const draft = createDraftMessage({
    id: input.draftId,
    from: session.profile,
    toEmail: input.toEmail,
    cc: input.cc,
    subject: input.subject,
    body: input.body,
    starred: currentDraft?.starred ?? false
  });

  if (session.storage === 'd1' && (await hasWorkspaceCoreTables(env))) {
    const capabilities = await getWorkspaceCapabilities(env);

    if (!capabilities.drafts) {
      throw new Error('草稿表尚未迁移，请先执行最新的 D1 schema。');
    }

    const payload = serializeDraftForInsert(session.userId, { ...input, draftId: draft.id }, draft.starred);
    const timestamp = nowIso();

    await env!.DB.batch([
      env!.DB.prepare(
        `
          INSERT INTO workspace_drafts (
            id,
            user_id,
            to_email,
            cc,
            subject,
            body,
            is_starred,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            to_email = excluded.to_email,
            cc = excluded.cc,
            subject = excluded.subject,
            body = excluded.body,
            is_starred = excluded.is_starred,
            updated_at = excluded.updated_at
        `
      ).bind(
        payload.id,
        payload.userId,
        payload.toEmail,
        payload.cc,
        payload.subject,
        payload.body,
        payload.isStarred,
        payload.createdAt,
        payload.updatedAt
      ),
      env!.DB.prepare(
        `
          UPDATE workspace_sessions
          SET updated_at = ?
          WHERE id = ?
        `
      ).bind(timestamp, session.id)
    ]);

    const nextSession = await refreshD1Session(env, session.id);

    if (!nextSession) {
      throw new Error('保存草稿后无法重新加载工作区。');
    }

    const message = nextSession.mailbox.drafts.find((item) => item.id === draft.id) ?? draft;

    return {
      message,
      workspace: serializeWorkspace(nextSession)
    };
  }

  session.mailbox = {
    inbox: session.mailbox.inbox.map(cloneMessage),
    sent: session.mailbox.sent.map(cloneMessage),
    drafts: sortMessages([
      draft,
      ...session.mailbox.drafts.filter((message) => message.id !== draft.id).map(cloneMessage)
    ])
  };
  touchMemorySession(session);
  memorySessions.set(session.id, cloneSession(session));
  return {
    message: draft,
    workspace: serializeWorkspace(session)
  };
}

export async function sendWorkspaceMessage(
  env: CloudflareEnv | undefined,
  session: WorkspaceSession,
  input: ComposeInput
) {
  const draftId = input.draftId?.trim() || undefined;
  const initialMessage = createSentMessage({
    id: draftId,
    from: session.profile,
    toEmail: input.toEmail,
    subject: input.subject,
    body: input.body,
    cc: input.cc,
    deliveryStatus: 'queued',
    deliveryAttempts: 0,
    deliveryError: '',
    deliveredAt: null
  });
  const initialDeliveryState = await deliverOutboundMessage(
    env,
    {
      messageId: initialMessage.id,
      fromName: initialMessage.fromName,
      fromEmail: initialMessage.fromEmail,
      toEmail: initialMessage.toEmail,
      cc: initialMessage.cc,
      subject: initialMessage.subject,
      text: initialMessage.body
    },
    0
  );
  const message = {
    ...initialMessage,
    deliveryStatus: initialDeliveryState.status,
    deliveryAttempts: initialDeliveryState.attempts,
    deliveryError: initialDeliveryState.lastError,
    deliveredAt: initialDeliveryState.deliveredAt,
    deliveryProvider: initialDeliveryState.provider,
    deliveryResultKind: initialDeliveryState.resultKind,
    deliveryRemoteStatus: initialDeliveryState.remoteStatus,
    deliveryResponsePreview: initialDeliveryState.responsePreview,
    deliveryLastEvent: 'submission',
    deliveryLastEventAt: initialDeliveryState.deliveredAt ?? nowIso()
  } satisfies MailMessage;

  if (session.storage === 'd1' && (await hasWorkspaceCoreTables(env))) {
    const capabilities = await getWorkspaceCapabilities(env);
    const payload = serializeMessageForInsert(session.userId, message);
    const timestamp = nowIso();
    const statements = [
      env!.DB.prepare(
        `
          INSERT INTO workspace_messages (
            user_id,
            id,
            folder,
            from_name,
            from_email,
            to_name,
            to_email,
            subject,
            preview,
            body,
            sent_at,
            labels_json,
            is_read,
            is_starred,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).bind(
        payload.userId,
        payload.id,
        payload.folder,
        payload.fromName,
        payload.fromEmail,
        payload.toName,
        payload.toEmail,
        payload.subject,
        payload.preview,
        payload.body,
        payload.sentAt,
        payload.labelsJson,
        payload.isRead,
        payload.isStarred,
        payload.createdAt,
        payload.updatedAt
      ),
      env!.DB.prepare(
        `
          UPDATE workspace_sessions
          SET updated_at = ?
          WHERE id = ?
        `
      ).bind(timestamp, session.id)
    ];

    if (capabilities.outboundStatuses) {
      const delivery = serializeOutboundStatusForUpsert(session.userId, message.id, initialDeliveryState);

      statements.unshift(
        env!.DB.prepare(
          `
            INSERT INTO workspace_outbound_statuses (
              message_id,
              user_id,
              status,
              attempts,
              delivered_at,
              last_error,
              provider_message_id,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        ).bind(
          delivery.messageId,
          delivery.userId,
          delivery.status,
          delivery.attempts,
          delivery.deliveredAt,
          delivery.lastError,
          delivery.providerMessageId,
          delivery.createdAt,
          delivery.updatedAt
        )
      );

      if (capabilities.outboundReceipts) {
        const receipt = serializeOutboundReceiptForUpsert(session.userId, message.id, initialDeliveryState);

        statements.unshift(
          env!.DB.prepare(
            `
              INSERT INTO workspace_outbound_receipts (
                message_id,
                user_id,
                provider,
                result_kind,
                remote_status,
                response_preview,
                last_event,
                last_event_at,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(message_id) DO UPDATE SET
                provider = excluded.provider,
                result_kind = excluded.result_kind,
                remote_status = excluded.remote_status,
                response_preview = excluded.response_preview,
                last_event = excluded.last_event,
                last_event_at = excluded.last_event_at,
                updated_at = excluded.updated_at
            `
          ).bind(
            receipt.messageId,
            receipt.userId,
            receipt.provider,
            receipt.resultKind,
            receipt.remoteStatus,
            receipt.responsePreview,
            receipt.lastEvent,
            receipt.lastEventAt,
            receipt.createdAt,
            receipt.updatedAt
          )
        );
      }

      if (capabilities.outboundEvents) {
        const event = serializeOutboundEventInsert({
          svixId: `local:${message.id}:submission:${initialDeliveryState.attempts}`,
          messageId: message.id,
          userId: session.userId,
          provider: initialDeliveryState.provider,
          providerMessageId: initialDeliveryState.providerMessageId,
          eventType: 'submission',
          eventCreatedAt: message.deliveryLastEventAt ?? nowIso(),
          summary: initialDeliveryState.responsePreview || initialDeliveryState.lastError || '邮件已提交到出站 provider。',
          payloadJson: JSON.stringify({
            provider: initialDeliveryState.provider,
            resultKind: initialDeliveryState.resultKind,
            status: initialDeliveryState.status,
            remoteStatus: initialDeliveryState.remoteStatus
          })
        });

        statements.unshift(
          env!.DB.prepare(
            `
              INSERT INTO workspace_outbound_events (
                svix_id,
                message_id,
                user_id,
                provider,
                provider_message_id,
                event_type,
                event_created_at,
                summary,
                payload_json,
                created_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
          ).bind(
            event.svixId,
            event.messageId,
            event.userId,
            event.provider,
            event.providerMessageId,
            event.eventType,
            event.eventCreatedAt,
            event.summary,
            event.payloadJson,
            event.createdAt
          )
        );
      }
    }

    if (draftId && capabilities.drafts) {
      statements.unshift(
        env!.DB.prepare(
          `
            DELETE FROM workspace_drafts
            WHERE user_id = ?
              AND id = ?
          `
        ).bind(session.userId, draftId)
      );
    }

    await env!.DB.batch(statements);

    const nextSession = await refreshD1Session(env, session.id);

    if (!nextSession) {
      throw new Error('发送邮件后无法重新加载工作区。');
    }

    return {
      message,
      workspace: serializeWorkspace(nextSession)
    };
  }

  session.mailbox = {
    inbox: session.mailbox.inbox.map(cloneMessage),
    sent: sortMessages([message, ...session.mailbox.sent.map(cloneMessage)]),
    drafts: session.mailbox.drafts
      .filter((item) => item.id !== draftId)
      .map(cloneMessage)
  };
  touchMemorySession(session);
  memorySessions.set(session.id, cloneSession(session));
  return {
    message,
    workspace: serializeWorkspace(session)
  };
}

export async function retryWorkspaceMessageDelivery(
  env: CloudflareEnv | undefined,
  session: WorkspaceSession,
  messageId: string
) {
  const currentMessage = findMessage(session, messageId);

  if (!currentMessage || currentMessage.folder !== 'sent' || currentMessage.source !== 'workspace') {
    return null;
  }

  const nextDeliveryState = await deliverOutboundMessage(
    env,
    {
      messageId: currentMessage.id,
      fromName: currentMessage.fromName,
      fromEmail: currentMessage.fromEmail,
      toEmail: currentMessage.toEmail,
      cc: currentMessage.cc,
      subject: currentMessage.subject,
      text: currentMessage.body
    },
    currentMessage.deliveryAttempts ?? 0
  );

  if (session.storage === 'd1' && (await hasWorkspaceCoreTables(env))) {
    const capabilities = await getWorkspaceCapabilities(env);

    if (!capabilities.outboundStatuses) {
      throw new Error('出站状态表尚未迁移，请先执行最新的 D1 schema。');
    }

    const delivery = serializeOutboundStatusForUpsert(session.userId, messageId, nextDeliveryState);
    const statements = [
      env!.DB.prepare(
        `
          INSERT INTO workspace_outbound_statuses (
            message_id,
            user_id,
            status,
            attempts,
            delivered_at,
            last_error,
            provider_message_id,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(message_id) DO UPDATE SET
            status = excluded.status,
            attempts = excluded.attempts,
            delivered_at = excluded.delivered_at,
            last_error = excluded.last_error,
            provider_message_id = excluded.provider_message_id,
            updated_at = excluded.updated_at
        `
      ).bind(
        delivery.messageId,
        delivery.userId,
        delivery.status,
        delivery.attempts,
        delivery.deliveredAt,
        delivery.lastError,
        delivery.providerMessageId,
        delivery.createdAt,
        delivery.updatedAt
      ),
      env!.DB.prepare(
        `
          UPDATE workspace_sessions
          SET updated_at = ?
          WHERE id = ?
        `
      ).bind(nowIso(), session.id)
    ];

    if (capabilities.outboundReceipts) {
      const receipt = serializeOutboundReceiptForUpsert(session.userId, messageId, nextDeliveryState);

      statements.unshift(
        env!.DB.prepare(
          `
            INSERT INTO workspace_outbound_receipts (
              message_id,
              user_id,
              provider,
              result_kind,
              remote_status,
              response_preview,
              last_event,
              last_event_at,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(message_id) DO UPDATE SET
              provider = excluded.provider,
              result_kind = excluded.result_kind,
              remote_status = excluded.remote_status,
              response_preview = excluded.response_preview,
              last_event = excluded.last_event,
              last_event_at = excluded.last_event_at,
              updated_at = excluded.updated_at
          `
        ).bind(
          receipt.messageId,
          receipt.userId,
          receipt.provider,
          receipt.resultKind,
          receipt.remoteStatus,
          receipt.responsePreview,
          receipt.lastEvent,
          receipt.lastEventAt,
          receipt.createdAt,
          receipt.updatedAt
        )
      );
    }

    if (capabilities.outboundEvents) {
      const eventCreatedAt = nextDeliveryState.deliveredAt ?? nowIso();
      const event = serializeOutboundEventInsert({
        svixId: `local:${messageId}:submission:${nextDeliveryState.attempts}`,
        messageId,
        userId: session.userId,
        provider: nextDeliveryState.provider,
        providerMessageId: nextDeliveryState.providerMessageId,
        eventType: 'submission',
        eventCreatedAt,
        summary: nextDeliveryState.responsePreview || nextDeliveryState.lastError || '邮件已重新提交到出站 provider。',
        payloadJson: JSON.stringify({
          provider: nextDeliveryState.provider,
          resultKind: nextDeliveryState.resultKind,
          status: nextDeliveryState.status,
          remoteStatus: nextDeliveryState.remoteStatus
        })
      });

      statements.unshift(
        env!.DB.prepare(
          `
            INSERT INTO workspace_outbound_events (
              svix_id,
              message_id,
              user_id,
              provider,
              provider_message_id,
              event_type,
              event_created_at,
              summary,
              payload_json,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        ).bind(
          event.svixId,
          event.messageId,
          event.userId,
          event.provider,
          event.providerMessageId,
          event.eventType,
          event.eventCreatedAt,
          event.summary,
          event.payloadJson,
          event.createdAt
        )
      );
    }

    await env!.DB.batch(statements);

    const nextSession = await refreshD1Session(env, session.id);

    if (!nextSession) {
      throw new Error('更新投递状态后无法重新加载工作区。');
    }

    const message = findMessage(nextSession, messageId);

    if (!message) {
      return null;
    }

    return {
      message,
      workspace: serializeWorkspace(nextSession)
    };
  }

  session.mailbox = {
    inbox: session.mailbox.inbox.map(cloneMessage),
    sent: sortMessages(
      session.mailbox.sent.map((message) =>
        message.id === messageId
          ? {
              ...cloneMessage(message),
              deliveryStatus: nextDeliveryState.status,
              deliveryAttempts: nextDeliveryState.attempts,
              deliveryError: nextDeliveryState.lastError,
              deliveredAt: nextDeliveryState.deliveredAt,
              deliveryProvider: nextDeliveryState.provider,
              deliveryResultKind: nextDeliveryState.resultKind,
              deliveryRemoteStatus: nextDeliveryState.remoteStatus,
              deliveryResponsePreview: nextDeliveryState.responsePreview,
              deliveryLastEvent: 'submission',
              deliveryLastEventAt: nextDeliveryState.deliveredAt ?? nowIso()
            }
          : cloneMessage(message)
      )
    ),
    drafts: session.mailbox.drafts.map(cloneMessage)
  };
  touchMemorySession(session);
  memorySessions.set(session.id, cloneSession(session));

  const message = findMessage(session, messageId);

  if (!message) {
    return null;
  }

  return {
    message,
    workspace: serializeWorkspace(session)
  };
}

export async function patchWorkspaceMessage(
  env: CloudflareEnv | undefined,
  session: WorkspaceSession,
  messageId: string,
  patch: MessagePatch
) {
  const currentMessage = findMessage(session, messageId);

  if (!currentMessage) {
    return null;
  }

  if (session.storage === 'd1' && (await hasWorkspaceCoreTables(env))) {
    const capabilities = await getWorkspaceCapabilities(env);

    if (isInboundMessageId(messageId)) {
      if (!capabilities.inboundStates) {
        throw new Error('入站状态表尚未迁移，请先执行最新的 D1 schema。');
      }

      const timestamp = nowIso();

      await env!.DB.batch([
        env!.DB.prepare(
          `
            INSERT INTO workspace_email_states (
              id,
              user_id,
              email_message_id,
              is_read,
              is_starred,
              deleted_at,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
            ON CONFLICT(user_id, email_message_id) DO UPDATE SET
              is_read = excluded.is_read,
              is_starred = excluded.is_starred,
              deleted_at = NULL,
              updated_at = excluded.updated_at
          `
        ).bind(
          crypto.randomUUID(),
          session.userId,
          fromInboundMessageId(messageId),
          (patch.read ?? currentMessage.read) ? 1 : 0,
          (patch.starred ?? currentMessage.starred) ? 1 : 0,
          timestamp,
          timestamp
        ),
        env!.DB.prepare(
          `
            UPDATE workspace_sessions
            SET updated_at = ?
            WHERE id = ?
          `
        ).bind(timestamp, session.id)
      ]);
    } else if (currentMessage.folder === 'drafts') {
      if (!capabilities.drafts) {
        throw new Error('草稿表尚未迁移，请先执行最新的 D1 schema。');
      }

      await env!.DB.batch([
        env!.DB.prepare(
          `
            UPDATE workspace_drafts
            SET
              is_starred = ?,
              updated_at = ?
            WHERE user_id = ?
              AND id = ?
          `
        ).bind((patch.starred ?? currentMessage.starred) ? 1 : 0, nowIso(), session.userId, messageId),
        env!.DB.prepare(
          `
            UPDATE workspace_sessions
            SET updated_at = ?
            WHERE id = ?
          `
        ).bind(nowIso(), session.id)
      ]);
    } else {
      await env!.DB.batch([
        env!.DB.prepare(
          `
            UPDATE workspace_messages
            SET
              is_read = ?,
              is_starred = ?,
              updated_at = ?
            WHERE user_id = ?
              AND id = ?
          `
        ).bind(
          (patch.read ?? currentMessage.read) ? 1 : 0,
          (patch.starred ?? currentMessage.starred) ? 1 : 0,
          nowIso(),
          session.userId,
          messageId
        ),
        env!.DB.prepare(
          `
            UPDATE workspace_sessions
            SET updated_at = ?
            WHERE id = ?
          `
        ).bind(nowIso(), session.id)
      ]);
    }

    const nextSession = await refreshD1Session(env, session.id);

    if (!nextSession) {
      throw new Error('更新邮件状态后无法重新加载工作区。');
    }

    const message = findMessage(nextSession, messageId);

    if (!message) {
      return null;
    }

    return {
      message,
      workspace: serializeWorkspace(nextSession)
    };
  }

  session.mailbox = {
    inbox: session.mailbox.inbox.map((message) =>
      message.id === messageId ? normalizePatch(message, patch) : cloneMessage(message)
    ),
    sent: session.mailbox.sent.map((message) =>
      message.id === messageId ? normalizePatch(message, patch) : cloneMessage(message)
    ),
    drafts: session.mailbox.drafts.map((message) =>
      message.id === messageId ? normalizePatch(message, patch) : cloneMessage(message)
    )
  };
  touchMemorySession(session);
  memorySessions.set(session.id, cloneSession(session));

  const message = findMessage(session, messageId);

  if (!message) {
    return null;
  }

  return {
    message,
    workspace: serializeWorkspace(session)
  };
}

export async function deleteWorkspaceMessage(
  env: CloudflareEnv | undefined,
  session: WorkspaceSession,
  messageId: string
) {
  const currentMessage = findMessage(session, messageId);

  if (!currentMessage) {
    return null;
  }

  const folder = currentMessage.folder;

  if (session.storage === 'd1' && (await hasWorkspaceCoreTables(env))) {
    const capabilities = await getWorkspaceCapabilities(env);
    const timestamp = nowIso();
    const statements = [
      env!.DB.prepare(
        `
          UPDATE workspace_sessions
          SET updated_at = ?
          WHERE id = ?
        `
      ).bind(timestamp, session.id)
    ];

    if (isInboundMessageId(messageId)) {
      if (!capabilities.inboundStates) {
        throw new Error('入站状态表尚未迁移，请先执行最新的 D1 schema。');
      }

      statements.unshift(
        env!.DB.prepare(
          `
            INSERT INTO workspace_email_states (
              id,
              user_id,
              email_message_id,
              is_read,
              is_starred,
              deleted_at,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, email_message_id) DO UPDATE SET
              deleted_at = excluded.deleted_at,
              updated_at = excluded.updated_at
          `
        ).bind(
          crypto.randomUUID(),
          session.userId,
          fromInboundMessageId(messageId),
          currentMessage.read ? 1 : 0,
          currentMessage.starred ? 1 : 0,
          timestamp,
          timestamp,
          timestamp
        )
      );
    } else if (folder === 'drafts') {
      if (!capabilities.drafts) {
        throw new Error('草稿表尚未迁移，请先执行最新的 D1 schema。');
      }

      statements.unshift(
        env!.DB.prepare(
          `
            DELETE FROM workspace_drafts
            WHERE user_id = ?
              AND id = ?
          `
        ).bind(session.userId, messageId)
      );
    } else {
      if (folder === 'sent' && capabilities.outboundStatuses) {
        statements.unshift(
          env!.DB.prepare(
            `
              DELETE FROM workspace_outbound_statuses
              WHERE user_id = ?
                AND message_id = ?
            `
          ).bind(session.userId, messageId)
        );
      }

      statements.unshift(
        env!.DB.prepare(
          `
            DELETE FROM workspace_messages
            WHERE user_id = ?
              AND id = ?
          `
        ).bind(session.userId, messageId)
      );
    }

    await env!.DB.batch(statements);

    const nextSession = await refreshD1Session(env, session.id);

    if (!nextSession) {
      throw new Error('删除邮件后无法重新加载工作区。');
    }

    return {
      folder,
      workspace: serializeWorkspace(nextSession)
    };
  }

  session.mailbox = {
    inbox: session.mailbox.inbox
      .filter((message) => message.id !== messageId)
      .map(cloneMessage),
    sent: session.mailbox.sent
      .filter((message) => message.id !== messageId)
      .map(cloneMessage),
    drafts: session.mailbox.drafts
      .filter((message) => message.id !== messageId)
      .map(cloneMessage)
  };
  touchMemorySession(session);
  memorySessions.set(session.id, cloneSession(session));
  return {
    folder,
    workspace: serializeWorkspace(session)
  };
}
