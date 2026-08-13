import type { Cookies } from '@sveltejs/kit';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { generateSessionToken, hashSessionToken } from '$lib/server/auth/token';
import { hashPassword, verifyPassword } from '$lib/server/auth/password';
import { getWorkspaceCapabilities, hasWorkspaceCoreTables } from '$lib/server/db/capabilities';
import { createSession, revokeSessionByTokenHash, touchSession } from '$lib/server/db/sessions';
import { findAuthUserByLogin } from '$lib/server/db/users';
import { loadD1Session, loadD1SessionByTokenHash } from '$lib/server/workspace/mailbox';
import type { WorkspaceSession } from '$lib/server/workspace/shared';

export const workspaceSessionCookie = 'flaremail_session';
export const secureWorkspaceSessionCookie = '__Host-flaremail_session';
export const legacyWorkspaceSessionCookie = 'flaremail_workspace';
export const workspaceSessionCookieNames = [secureWorkspaceSessionCookie, workspaceSessionCookie, legacyWorkspaceSessionCookie] as const;
export type CookieOptions = Parameters<Cookies['set']>[2];

const SESSION_HOURS = 12;
const REMEMBER_SESSION_DAYS = 7;
let dummyCredentialHash: Promise<string> | null = null;

async function getDummyCredentialHash() {
  dummyCredentialHash ??= hashPassword(generateSessionToken());
  return dummyCredentialHash;
}

export class WorkspaceAuthUnavailableError extends Error {
  constructor() {
    super('Workspace authentication is not configured.');
    this.name = 'WorkspaceAuthUnavailableError';
  }
}

export interface AuthenticatedWorkspace {
  session: WorkspaceSession;
  token: string;
}

export function isSecureSessionRequest(url: URL, env?: CloudflareEnv): boolean {
  if (env?.APP_ORIGIN) {
    try {
      return new URL(env.APP_ORIGIN).protocol === 'https:';
    } catch {
      return url.protocol === 'https:';
    }
  }
  return url.protocol === 'https:';
}

export function getWorkspaceSessionCookieName(secure: boolean) {
  return secure ? secureWorkspaceSessionCookie : workspaceSessionCookie;
}

export async function getWorkspaceSession(env: CloudflareEnv | undefined, token?: string | null) {
  if (!token || !(await hasWorkspaceCoreTables(env))) return null;
  try {
    const tokenHash = await hashSessionToken(token);
    const session = await loadD1SessionByTokenHash(env!, tokenHash);
    if (session) await touchSession(env!.DB, session.id).run();
    return session;
  } catch {
    // Missing auth migrations or unavailable bindings must never fall back to
    // an implicit account. Treat the request as unauthenticated.
    return null;
  }
}

export async function authenticateWorkspaceUser(
  env: CloudflareEnv | undefined,
  email: string,
  password: string,
  remember = false
): Promise<AuthenticatedWorkspace | null> {
  if (!env?.DB || !(await hasWorkspaceCoreTables(env))) throw new WorkspaceAuthUnavailableError();

  let user;
  try {
    user = await findAuthUserByLogin(env.DB, email.trim());
  } catch {
    throw new WorkspaceAuthUnavailableError();
  }
  const credentialHash = user?.credential_hash ?? await getDummyCredentialHash();
  const passwordMatches = await verifyPassword(password, credentialHash);
  if (!user?.credential_hash || !passwordMatches) return null;

  const token = generateSessionToken();
  const tokenHash = await hashSessionToken(token);
  const lifetimeMs = remember ? REMEMBER_SESSION_DAYS * 24 * 60 * 60 * 1000 : SESSION_HOURS * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + lifetimeMs).toISOString();
  const sessionId = await createSession(env.DB, user.id, tokenHash, expiresAt);
  const session = await loadD1Session(env, sessionId, await getWorkspaceCapabilities(env));
  if (!session) throw new WorkspaceAuthUnavailableError();
  return { session, token };
}

export async function destroyWorkspaceSession(env: CloudflareEnv | undefined, token?: string | null) {
  if (!env?.DB || !token) return;
  try {
    await revokeSessionByTokenHash(env.DB, await hashSessionToken(token));
  } catch {
    // Logout remains idempotent if D1 is temporarily unavailable.
  }
}

export function sessionCookieOptions(remember: boolean, secure: boolean): CookieOptions {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: remember ? REMEMBER_SESSION_DAYS * 24 * 60 * 60 : undefined
  };
}

export function clearSessionCookieOptions(secure: boolean): CookieOptions {
  return { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: 0 };
}
