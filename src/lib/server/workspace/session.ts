import type { Cookies } from '@sveltejs/kit';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { getWorkspaceCapabilities, hasWorkspaceCoreTables } from '$lib/server/db/capabilities';
import { createSession, deleteSession } from '$lib/server/db/sessions';
import { ensureDemoUser } from '$lib/server/db/users';
import { loadD1Session } from '$lib/server/workspace/mailbox';
import { cloneSession, createMemoryWorkspaceSession, demoCredentials, touchMemorySession, workspaceSessionCookie, type WorkspaceSession } from '$lib/server/workspace/shared';

export { workspaceSessionCookie };
export type CookieOptions = Parameters<Cookies['set']>[2];

const memorySessions = new Map<string, WorkspaceSession>();

export async function getWorkspaceSession(env: CloudflareEnv | undefined, sessionId?: string | null) {
  if (!sessionId) return null;
  if (await hasWorkspaceCoreTables(env)) {
    const d1Session = await loadD1Session(env!, sessionId);
    if (d1Session) return d1Session;
  }
  return memorySessions.get(sessionId) ?? null;
}

export async function authenticateWorkspaceUser(env: CloudflareEnv | undefined, email: string, password: string) {
  if (email.trim() !== demoCredentials.email || password.trim() !== demoCredentials.password) return null;
  if (await hasWorkspaceCoreTables(env)) {
    const capabilities = await getWorkspaceCapabilities(env);
    const user = await ensureDemoUser(env!.DB, capabilities);
    const sessionId = await createSession(env!.DB, user.id);
    return loadD1Session(env!, sessionId, capabilities);
  }
  const session = createMemoryWorkspaceSession();
  memorySessions.set(session.id, session);
  return cloneSession(session);
}

export async function destroyWorkspaceSession(env: CloudflareEnv | undefined, sessionId?: string | null) {
  if (!sessionId) return;
  memorySessions.delete(sessionId);
  if (await hasWorkspaceCoreTables(env)) await deleteSession(env!.DB, sessionId);
}

export function persistMemorySession(session: WorkspaceSession) {
  touchMemorySession(session);
  memorySessions.set(session.id, cloneSession(session));
  return session;
}

export function sessionCookieOptions(remember: boolean): CookieOptions {
  return { path: '/', httpOnly: true, sameSite: 'lax', secure: false, maxAge: remember ? 60 * 60 * 24 * 7 : undefined };
}
export function clearSessionCookieOptions(): CookieOptions {
  return { path: '/', httpOnly: true, sameSite: 'lax', secure: false, maxAge: 0 };
}
