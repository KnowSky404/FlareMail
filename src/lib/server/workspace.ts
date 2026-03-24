import type { Cookies } from '@sveltejs/kit';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import {
  cloneMailbox,
  cloneProfile,
  createDraftMessage,
  createIncomingMessage,
  createSentMessage,
  createWorkspacePayload,
  demoCredentials,
  fromInboundMessageId,
  isInboundMessageId,
  mockMailbox,
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

const memorySessions = new Map<string, WorkspaceSession>();

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

const previewFromBody = (value: string) => value.trim().replace(/\s+/g, ' ').slice(0, 96);

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

const mapWorkspaceMessageRow = (row: WorkspaceMessageRow): MailMessage => ({
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
  starred: Boolean(row.is_starred)
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

const rowsToMailbox = (
  rows: WorkspaceMessageRow[],
  draftRows: WorkspaceDraftRow[],
  inboundRows: WorkspaceInboundRow[],
  profile: UserProfile
): MailboxState => {
  const mailbox: MailboxState = {
    inbox: [],
    sent: [],
    drafts: []
  };

  for (const row of rows) {
    const message = mapWorkspaceMessageRow(row);
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
      inboundStates: false
    };
  }

  try {
    const [drafts, inboundStates] = await Promise.all([
      hasNamedTables(env.DB, ['workspace_drafts']),
      hasNamedTables(env.DB, ['workspace_email_states'])
    ]);

    return {
      drafts,
      inboundStates
    };
  } catch {
    return {
      drafts: false,
      inboundStates: false
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
  const [messageRows, draftRows, inboundRows] = await Promise.all([
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
      : Promise.resolve({ results: [] as WorkspaceInboundRow[] })
  ]);

  return {
    id: sessionRow.session_id,
    userId: sessionRow.id,
    profile,
    mailbox: rowsToMailbox(
      messageRows.results ?? [],
      draftRows.results ?? [],
      inboundRows.results ?? [],
      profile
    ),
    incomingSequence: sessionRow.incoming_sequence,
    createdAt: sessionRow.created_at,
    updatedAt: sessionRow.updated_at,
    storage: 'd1' as const
  };
}

async function seedWorkspaceMailboxIfEmpty(db: D1Database, userId: string) {
  const existing = await db.prepare(
    `
      SELECT COUNT(*) AS total
      FROM workspace_messages
      WHERE user_id = ?
    `
  ).bind(userId).first<{ total: number }>();

  if ((existing?.total ?? 0) > 0) {
    return;
  }

  const statements = [...mockMailbox.inbox, ...mockMailbox.sent].map((message) => {
    const payload = serializeMessageForInsert(userId, message);

    return db.prepare(
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
    );
  });

  await db.batch(statements);
}

async function seedWorkspaceDraftsIfEmpty(db: D1Database, userId: string) {
  const existing = await db.prepare(
    `
      SELECT COUNT(*) AS total
      FROM workspace_drafts
      WHERE user_id = ?
    `
  ).bind(userId).first<{ total: number }>();

  if ((existing?.total ?? 0) > 0) {
    return;
  }

  const statements = mockMailbox.drafts.map((draft) =>
    db.prepare(
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
      `
    ).bind(
      draft.id,
      userId,
      draft.toEmail,
      draft.cc ?? '',
      draft.subject,
      draft.body,
      draft.starred ? 1 : 0,
      draft.sentAt,
      draft.sentAt
    )
  );

  await db.batch(statements);
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

  await seedWorkspaceMailboxIfEmpty(db, user.id);

  if (capabilities.drafts) {
    await seedWorkspaceDraftsIfEmpty(db, user.id);
  }

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

export function serializeWorkspace(session: WorkspaceSession): WorkspacePayload {
  return createWorkspacePayload(session.profile, session.mailbox);
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

export async function receiveDemoMessage(env: CloudflareEnv | undefined, session: WorkspaceSession) {
  if (session.storage === 'd1' && (await hasWorkspaceCoreTables(env))) {
    const nextSequence = session.incomingSequence + 1;
    const message = createIncomingMessage(session.profile, nextSequence);
    const payload = serializeMessageForInsert(session.userId, message);
    const timestamp = nowIso();

    await env!.DB.batch([
      env!.DB.prepare(
        `
          UPDATE workspace_users
          SET
            incoming_sequence = ?,
            updated_at = ?
          WHERE id = ?
        `
      ).bind(nextSequence, timestamp, session.userId),
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
    ]);

    const nextSession = await refreshD1Session(env, session.id);

    if (!nextSession) {
      throw new Error('新邮件写入后无法重新加载工作区。');
    }

    return {
      message,
      workspace: serializeWorkspace(nextSession)
    };
  }

  session.incomingSequence += 1;
  const message = createIncomingMessage(session.profile, session.incomingSequence);
  session.mailbox = {
    ...session.mailbox,
    inbox: [message, ...session.mailbox.inbox.map(cloneMessage)]
  };
  touchMemorySession(session);
  memorySessions.set(session.id, cloneSession(session));
  return {
    message,
    workspace: serializeWorkspace(session)
  };
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
  const message = createSentMessage({
    id: draftId,
    from: session.profile,
    toEmail: input.toEmail,
    subject: input.subject,
    body: input.body,
    cc: input.cc
  });

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
