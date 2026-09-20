import type { Cookies } from '@sveltejs/kit';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { generateSessionToken, hashSessionToken } from '$lib/server/auth/token';
import { getDummyPasswordHash, verifyPassword } from '$lib/server/auth/password';
import { hasWorkspaceCoreTables } from '$lib/server/db/capabilities';
import { createSession, revokeSessionByTokenHash, touchSession, type SessionAuthContext } from '$lib/server/db/sessions';
import { findAuthUserByLogin, findWorkspaceOwnerId, hasWorkspaceOwnerCredential } from '$lib/server/db/users';
import { loadD1WorkspaceContext, loadD1WorkspaceContextByTokenHash } from '$lib/server/workspace/mailbox';
import type { WorkspaceContext } from '$lib/server/workspace/shared';

export const workspaceSessionCookie = 'flaremail_session';
export const secureWorkspaceSessionCookie = '__Host-flaremail_session';
export const legacyWorkspaceSessionCookie = 'flaremail_workspace';
export const workspaceSessionCookieNames = [secureWorkspaceSessionCookie, workspaceSessionCookie, legacyWorkspaceSessionCookie] as const;
export type CookieOptions = Parameters<Cookies['set']>[2];

const SESSION_HOURS = 12;
const REMEMBER_SESSION_DAYS = 7;
const ACCESS_SESSION_MAX_AGE_MS = 30 * 60 * 1000;

export class WorkspaceAuthUnavailableError extends Error {
  constructor() {
    super('Workspace authentication is not configured.');
    this.name = 'WorkspaceAuthUnavailableError';
  }
}

export class WorkspaceAuthNotConfiguredError extends Error {
  constructor() {
    super('Local Owner credentials are not configured.');
    this.name = 'WorkspaceAuthNotConfiguredError';
  }
}

export interface AuthenticatedWorkspace {
  session: WorkspaceContext;
  token: string;
}

export function isSecureSessionRequest(url: URL): boolean {
  return url.protocol === 'https:';
}

export function getWorkspaceSessionCookieName(secure: boolean) {
  return secure ? secureWorkspaceSessionCookie : workspaceSessionCookie;
}

export async function getWorkspaceSession(
  env: CloudflareEnv | undefined,
  token?: string | null,
  authContext: SessionAuthContext = { authMethod: 'local' }
) {
  if (!token || !env?.DB) return null;
  try {
    if (!(await hasWorkspaceCoreTables(env))) throw new WorkspaceAuthUnavailableError();
    const tokenHash = await hashSessionToken(token);
    const ownerId = await findWorkspaceOwnerId(env.DB);
    if (!ownerId) return null;
    const session = await loadD1WorkspaceContextByTokenHash(env, tokenHash, authContext);
    if (session?.userId !== ownerId) return null;
    if (session) await touchSession(env!.DB, session.id).run();
    return session;
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'auth_session_store_unavailable', errorName: error instanceof Error ? error.name : 'UnknownError' }));
    throw new WorkspaceAuthUnavailableError();
  }
}

export async function authenticateWorkspaceUser(
  env: CloudflareEnv | undefined,
  username: string,
  password: string,
  remember = false
): Promise<AuthenticatedWorkspace | null> {
  if (!env?.DB || !(await hasWorkspaceCoreTables(env))) throw new WorkspaceAuthUnavailableError();

  const startedAt = Date.now();
  let user;
  try {
    const ownerId = await findWorkspaceOwnerId(env.DB);
    if (!ownerId) throw new WorkspaceAuthNotConfiguredError();
    if (!(await hasWorkspaceOwnerCredential(env.DB))) throw new WorkspaceAuthNotConfiguredError();
    user = await findAuthUserByLogin(env.DB, username.trim().toLowerCase());
  } catch (error) {
    if (error instanceof WorkspaceAuthNotConfiguredError) throw error;
    throw new WorkspaceAuthUnavailableError();
  }
  const credentialHash = user?.credential_hash ?? getDummyPasswordHash();
  const passwordMatches = await verifyPassword(password, credentialHash);
  console.log(JSON.stringify({ event: 'auth_verify', outcome: user?.credential_hash && passwordMatches ? 'success' : 'rejected', durationMs: Date.now() - startedAt }));
  if (!user?.credential_hash || !passwordMatches) return null;

  const token = generateSessionToken();
  const tokenHash = await hashSessionToken(token);
  const lifetimeMs = remember ? REMEMBER_SESSION_DAYS * 24 * 60 * 60 * 1000 : SESSION_HOURS * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + lifetimeMs).toISOString();
  const sessionId = await createSession(env.DB, user.id, tokenHash, expiresAt);
  const session = await loadD1WorkspaceContext(env, sessionId);
  if (!session) throw new WorkspaceAuthUnavailableError();
  return { session, token };
}

export async function createAccessWorkspaceSession(
  env: CloudflareEnv | undefined,
  ownerId: string,
  principalId: string,
  tokenExpiresAt: number,
  now = Date.now()
): Promise<AuthenticatedWorkspace & { expiresAt: string }> {
  if (!env?.DB || !(await hasWorkspaceCoreTables(env))) throw new WorkspaceAuthUnavailableError();
  if (!ownerId.trim() || !principalId.trim() || !Number.isSafeInteger(tokenExpiresAt)) {
    throw new WorkspaceAuthUnavailableError();
  }
  try {
    if ((await findWorkspaceOwnerId(env.DB)) !== ownerId) throw new WorkspaceAuthUnavailableError();
  } catch {
    throw new WorkspaceAuthUnavailableError();
  }

  const expiresAtMs = Math.min(tokenExpiresAt * 1000, now + ACCESS_SESSION_MAX_AGE_MS);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now) throw new WorkspaceAuthUnavailableError();
  const expiresAt = new Date(expiresAtMs).toISOString();
  const token = generateSessionToken();
  const tokenHash = await hashSessionToken(token);
  const sessionId = await createSession(env.DB, ownerId, tokenHash, expiresAt, {
    authMethod: 'cloudflare-access',
    principalId
  });
  const session = await loadD1WorkspaceContext(env, sessionId);
  if (!session || session.userId !== ownerId || session.principalId !== principalId) {
    await revokeSessionByTokenHash(env.DB, tokenHash).catch(() => undefined);
    throw new WorkspaceAuthUnavailableError();
  }
  return { session, token, expiresAt };
}

export async function destroyWorkspaceSession(env: CloudflareEnv | undefined, token?: string | null): Promise<boolean> {
  if (!token) return true;
  if (!env?.DB) return false;
  try {
    await revokeSessionByTokenHash(env.DB, await hashSessionToken(token));
    return true;
  } catch {
    return false;
  }
}

export function sessionCookieOptions(remember: boolean, secure: boolean, maxAgeSeconds?: number): CookieOptions {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: maxAgeSeconds ?? (remember ? REMEMBER_SESSION_DAYS * 24 * 60 * 60 : undefined)
  };
}

export function clearSessionCookieOptions(secure: boolean): CookieOptions {
  return { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: 0 };
}
