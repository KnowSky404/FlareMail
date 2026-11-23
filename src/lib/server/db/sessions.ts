import type { WorkspaceSessionJoinRow } from '$lib/server/workspace/shared';

export interface ActiveSessionCapabilityRow {
  user_id: string;
  token_hash: string;
  expires_at: string;
}

export interface SessionAuthContext {
  authMethod: 'local' | 'cloudflare-access';
  principalId?: string | null;
}

const sessionTouchCutoff = (timestamp: string) => new Date(Date.parse(timestamp) - 5 * 60 * 1000).toISOString();

export async function findSessionJoin(db: D1Database, sessionId: string) {
  return db.prepare(`
    SELECT s.id AS session_id, s.created_at, s.updated_at, s.auth_method, s.principal_id,
      u.id, u.login_email, u.name, u.role, u.email, u.company, u.location, u.timezone,
      u.forwarding_enabled, u.signature, u.incoming_sequence
    FROM workspace_sessions AS s JOIN workspace_users AS u ON u.id = s.user_id
    WHERE s.id = ?
  `).bind(sessionId).first<WorkspaceSessionJoinRow>();
}

export async function findSessionJoinByTokenHash(
  db: D1Database,
  tokenHash: string,
  timestamp = new Date().toISOString(),
  authContext: SessionAuthContext = { authMethod: 'local' }
) {
  return db.prepare(`
    SELECT s.id AS session_id, s.created_at, s.updated_at, s.auth_method, s.principal_id,
      (s.last_seen_at IS NULL OR s.last_seen_at <= ?) AS needs_touch,
      u.id, u.login_email, u.name, u.role, u.email, u.company, u.location, u.timezone,
      u.forwarding_enabled, u.signature, u.incoming_sequence
    FROM workspace_sessions AS s JOIN workspace_users AS u ON u.id = s.user_id
    JOIN workspace_owner AS owner ON owner.singleton = 1 AND owner.user_id = u.id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
      AND s.auth_method = ? AND s.principal_id IS ?
  `).bind(sessionTouchCutoff(timestamp), tokenHash, timestamp, authContext.authMethod, authContext.principalId ?? null)
    .first<WorkspaceSessionJoinRow & { needs_touch: number }>();
}

export async function findActiveSessionCapability(
  db: D1Database,
  sessionId: string,
  timestamp = new Date().toISOString()
) {
  return db.prepare(`
    SELECT user_id, token_hash, expires_at
    FROM workspace_sessions
    WHERE id = ? AND token_hash IS NOT NULL AND revoked_at IS NULL AND expires_at > ?
  `).bind(sessionId, timestamp).first<ActiveSessionCapabilityRow>();
}

export async function createSession(
  db: D1Database,
  userId: string,
  tokenHash: string,
  expiresAt: string,
  authContext: SessionAuthContext = { authMethod: 'local' }
) {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  await db.prepare(`
    INSERT INTO workspace_sessions (
      id, user_id, token_hash, expires_at, last_seen_at, auth_method, principal_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, userId, tokenHash, expiresAt, timestamp, authContext.authMethod, authContext.principalId ?? null, timestamp, timestamp).run();
  return id;
}

export function touchSession(db: D1Database, sessionId: string, timestamp = new Date().toISOString()) {
  return db.prepare(`
    UPDATE workspace_sessions SET updated_at = ?, last_seen_at = ?
    WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND (last_seen_at IS NULL OR last_seen_at <= ?)
  `).bind(timestamp, timestamp, sessionId, timestamp, sessionTouchCutoff(timestamp));
}

export async function deleteSession(db: D1Database, sessionId: string) {
  await db.prepare(`DELETE FROM workspace_sessions WHERE id = ?`).bind(sessionId).run();
}

export async function revokeSessionByTokenHash(db: D1Database, tokenHash: string, timestamp = new Date().toISOString()) {
  await db.prepare(`
    UPDATE workspace_sessions SET revoked_at = ?, updated_at = ?
    WHERE token_hash = ? AND revoked_at IS NULL
  `).bind(timestamp, timestamp, tokenHash).run();
}
