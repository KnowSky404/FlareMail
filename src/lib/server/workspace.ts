import type { Cookies } from '@sveltejs/kit';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import {
  cloneMailbox,
  cloneProfile,
  createIncomingMessage,
  createSentMessage,
  createWorkspacePayload,
  demoCredentials,
  mockMailbox,
  mockProfile,
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

type WorkspaceUserRow = {
  id: string;
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
  folder: MailFolder;
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

const mapMessageRow = (row: WorkspaceMessageRow): MailMessage => ({
  id: row.id,
  folder: row.folder,
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

const rowsToMailbox = (rows: WorkspaceMessageRow[]): MailboxState => {
  const mailbox: MailboxState = {
    inbox: [],
    sent: []
  };

  for (const row of rows) {
    const message = mapMessageRow(row);
    mailbox[message.folder].push(message);
  }

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

async function hasWorkspaceTables(env?: CloudflareEnv) {
  if (!env?.DB) {
    return false;
  }

  try {
    const row = await env.DB.prepare(
      `
        SELECT COUNT(*) AS total
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('workspace_users', 'workspace_sessions', 'workspace_messages')
      `
    ).first<{ total: number }>();

    return (row?.total ?? 0) === 3;
  } catch {
    return false;
  }
}

async function fetchD1Session(db: D1Database, sessionId: string) {
  const sessionRow = await db.prepare(
    `
      SELECT
        s.id AS session_id,
        s.created_at,
        s.updated_at,
        u.id,
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

  const messageRows = await db.prepare(
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
  ).bind(sessionRow.id).all<WorkspaceMessageRow>();

  return {
    id: sessionRow.session_id,
    userId: sessionRow.id,
    profile: mapUserRowToProfile(sessionRow),
    mailbox: rowsToMailbox(messageRows.results ?? []),
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

async function ensureDemoUser(db: D1Database) {
  let user = await db.prepare(
    `
      SELECT
        id,
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
  return user;
}

export function serializeWorkspace(session: WorkspaceSession): WorkspacePayload {
  return createWorkspacePayload(session.profile, session.mailbox);
}

export async function getWorkspaceSession(env: CloudflareEnv | undefined, sessionId?: string | null) {
  if (!sessionId) {
    return null;
  }

  if (await hasWorkspaceTables(env)) {
    const d1Session = await fetchD1Session(env!.DB, sessionId);

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

  if (await hasWorkspaceTables(env)) {
    const user = await ensureDemoUser(env!.DB);
    const sessionId = crypto.randomUUID();
    const timestamp = nowIso();

    await env!.DB.prepare(
      `
        INSERT INTO workspace_sessions (id, user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `
    ).bind(sessionId, user.id, timestamp, timestamp).run();

    return fetchD1Session(env!.DB, sessionId);
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

  if (await hasWorkspaceTables(env)) {
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
  if (!(await hasWorkspaceTables(env))) {
    return null;
  }

  return fetchD1Session(env!.DB, sessionId);
}

export async function updateWorkspaceProfile(
  env: CloudflareEnv | undefined,
  session: WorkspaceSession,
  nextProfile: UserProfile
) {
  const profile = normalizeProfile(nextProfile);

  if (session.storage === 'd1' && (await hasWorkspaceTables(env))) {
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
  if (session.storage === 'd1' && (await hasWorkspaceTables(env))) {
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

export async function sendWorkspaceMessage(
  env: CloudflareEnv | undefined,
  session: WorkspaceSession,
  input: ComposeInput
) {
  const message = createSentMessage({
    from: session.profile,
    toEmail: input.toEmail,
    subject: input.subject,
    body: input.body,
    cc: input.cc
  });

  if (session.storage === 'd1' && (await hasWorkspaceTables(env))) {
    const payload = serializeMessageForInsert(session.userId, message);
    const timestamp = nowIso();

    await env!.DB.batch([
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
      throw new Error('发送邮件后无法重新加载工作区。');
    }

    return {
      message,
      workspace: serializeWorkspace(nextSession)
    };
  }

  session.mailbox = {
    ...session.mailbox,
    sent: [message, ...session.mailbox.sent.map(cloneMessage)]
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
  const currentMessage =
    session.mailbox.inbox.find((message) => message.id === messageId) ??
    session.mailbox.sent.find((message) => message.id === messageId) ??
    null;

  if (!currentMessage) {
    return null;
  }

  if (session.storage === 'd1' && (await hasWorkspaceTables(env))) {
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

    const nextSession = await refreshD1Session(env, session.id);

    if (!nextSession) {
      throw new Error('更新邮件状态后无法重新加载工作区。');
    }

    const message =
      nextSession.mailbox.inbox.find((item) => item.id === messageId) ??
      nextSession.mailbox.sent.find((item) => item.id === messageId) ??
      null;

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
    )
  };
  touchMemorySession(session);
  memorySessions.set(session.id, cloneSession(session));

  const message =
    session.mailbox.inbox.find((item) => item.id === messageId) ??
    session.mailbox.sent.find((item) => item.id === messageId) ??
    null;

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
  const folder =
    session.mailbox.inbox.some((message) => message.id === messageId)
      ? 'inbox'
      : session.mailbox.sent.some((message) => message.id === messageId)
        ? 'sent'
        : null;

  if (!folder) {
    return null;
  }

  if (session.storage === 'd1' && (await hasWorkspaceTables(env))) {
    await env!.DB.batch([
      env!.DB.prepare(
        `
          DELETE FROM workspace_messages
          WHERE user_id = ?
            AND id = ?
        `
      ).bind(session.userId, messageId),
      env!.DB.prepare(
        `
          UPDATE workspace_sessions
          SET updated_at = ?
          WHERE id = ?
        `
      ).bind(nowIso(), session.id)
    ]);

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
      .map(cloneMessage)
  };
  touchMemorySession(session);
  memorySessions.set(session.id, cloneSession(session));
  return {
    folder,
    workspace: serializeWorkspace(session)
  };
}
