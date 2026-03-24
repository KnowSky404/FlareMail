import type { Cookies } from '@sveltejs/kit';
import {
  cloneMailbox,
  cloneProfile,
  createIncomingMessage,
  createSentMessage,
  createWorkspacePayload,
  demoCredentials,
  type ComposeInput,
  type MailMessage,
  type MailboxState,
  type MessagePatch,
  type UserProfile,
  type WorkspacePayload
} from '$lib/mock/mailbox';

export const workspaceSessionCookie = 'flaremail_workspace';
type CookieOptions = Parameters<Cookies['set']>[2];

export interface MockWorkspaceSession {
  id: string;
  profile: UserProfile;
  mailbox: MailboxState;
  incomingSequence: number;
  createdAt: string;
  updatedAt: string;
}

const sessions = new Map<string, MockWorkspaceSession>();

const touchSession = (session: MockWorkspaceSession) => {
  session.updatedAt = new Date().toISOString();
  return session;
};

const cloneSessionMessage = (message: MailMessage): MailMessage => ({
  ...message,
  labels: [...message.labels]
});

export function createMockWorkspaceSession(): MockWorkspaceSession {
  const now = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    profile: cloneProfile(),
    mailbox: cloneMailbox(),
    incomingSequence: 0,
    createdAt: now,
    updatedAt: now
  };
}

export function serializeWorkspace(session: MockWorkspaceSession): WorkspacePayload {
  return createWorkspacePayload(session.profile, session.mailbox);
}

export function getWorkspaceSession(sessionId?: string | null) {
  if (!sessionId) {
    return null;
  }

  return sessions.get(sessionId) ?? null;
}

export function authenticateWorkspaceUser(email: string, password: string) {
  if (email.trim() !== demoCredentials.email || password.trim() !== demoCredentials.password) {
    return null;
  }

  const session = createMockWorkspaceSession();
  sessions.set(session.id, session);
  return session;
}

export function destroyWorkspaceSession(sessionId?: string | null) {
  if (!sessionId) {
    return;
  }

  sessions.delete(sessionId);
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

export function updateWorkspaceProfile(
  session: MockWorkspaceSession,
  nextProfile: UserProfile
): WorkspacePayload {
  session.profile = {
    name: nextProfile.name.trim(),
    role: nextProfile.role.trim(),
    email: nextProfile.email.trim(),
    company: nextProfile.company.trim(),
    location: nextProfile.location.trim(),
    timezone: nextProfile.timezone.trim(),
    forwardingEnabled: nextProfile.forwardingEnabled,
    signature: nextProfile.signature.trim()
  };

  touchSession(session);
  return serializeWorkspace(session);
}

export function receiveDemoMessage(session: MockWorkspaceSession) {
  session.incomingSequence += 1;
  const message = createIncomingMessage(session.profile, session.incomingSequence);
  session.mailbox = {
    ...session.mailbox,
    inbox: [message, ...session.mailbox.inbox.map(cloneSessionMessage)]
  };

  touchSession(session);
  return {
    message,
    workspace: serializeWorkspace(session)
  };
}

export function sendWorkspaceMessage(session: MockWorkspaceSession, input: ComposeInput) {
  const message = createSentMessage({
    from: session.profile,
    toEmail: input.toEmail,
    subject: input.subject,
    body: input.body,
    cc: input.cc
  });

  session.mailbox = {
    ...session.mailbox,
    sent: [message, ...session.mailbox.sent.map(cloneSessionMessage)]
  };

  touchSession(session);
  return {
    message,
    workspace: serializeWorkspace(session)
  };
}

const updateMessageList = (
  messages: MailMessage[],
  id: string,
  patch: MessagePatch
): { messages: MailMessage[]; updated: MailMessage | null } => {
  let updated: MailMessage | null = null;

  return {
    messages: messages.map((message) => {
      if (message.id !== id) {
        return cloneSessionMessage(message);
      }

      updated = {
        ...cloneSessionMessage(message),
        read: patch.read ?? message.read,
        starred: patch.starred ?? message.starred
      };

      return updated;
    }),
    updated
  };
};

export function patchWorkspaceMessage(
  session: MockWorkspaceSession,
  messageId: string,
  patch: MessagePatch
) {
  const inboxResult = updateMessageList(session.mailbox.inbox, messageId, patch);
  const sentResult = updateMessageList(session.mailbox.sent, messageId, patch);
  const updated = inboxResult.updated ?? sentResult.updated;

  if (!updated) {
    return null;
  }

  session.mailbox = {
    inbox: inboxResult.messages,
    sent: sentResult.messages
  };

  touchSession(session);
  return {
    message: updated,
    workspace: serializeWorkspace(session)
  };
}

export function deleteWorkspaceMessage(session: MockWorkspaceSession, messageId: string) {
  const inboxMatch = session.mailbox.inbox.some((message) => message.id === messageId);
  const sentMatch = session.mailbox.sent.some((message) => message.id === messageId);

  if (!inboxMatch && !sentMatch) {
    return null;
  }

  session.mailbox = {
    inbox: session.mailbox.inbox
      .filter((message) => message.id !== messageId)
      .map(cloneSessionMessage),
    sent: session.mailbox.sent
      .filter((message) => message.id !== messageId)
      .map(cloneSessionMessage)
  };

  touchSession(session);
  return {
    folder: inboxMatch ? 'inbox' : 'sent',
    workspace: serializeWorkspace(session)
  };
}
