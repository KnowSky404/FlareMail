import type { WorkspaceSessionJoinRow } from '$lib/server/workspace/shared';

export async function findSessionJoin(db: D1Database, sessionId: string) {
  return db.prepare(`
    SELECT s.id AS session_id, s.created_at, s.updated_at,
      u.id, u.login_email, u.name, u.role, u.email, u.company, u.location, u.timezone,
      u.forwarding_enabled, u.signature, u.incoming_sequence
    FROM workspace_sessions AS s JOIN workspace_users AS u ON u.id = s.user_id
    WHERE s.id = ?
  `).bind(sessionId).first<WorkspaceSessionJoinRow>();
}

export async function findSessionJoinByTokenHash(db: D1Database, tokenHash: string, timestamp = new Date().toISOString()) {
  return db.prepare(`
    SELECT s.id AS session_id, s.created_at, s.updated_at,
      u.id, u.login_email, u.name, u.role, u.email, u.company, u.location, u.timezone,
      u.forwarding_enabled, u.signature, u.incoming_sequence
    FROM workspace_sessions AS s JOIN workspace_users AS u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
  `).bind(tokenHash, timestamp).first<WorkspaceSessionJoinRow>();
}

export async function createSession(db: D1Database, userId: string, tokenHash: string, expiresAt: string) {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  await db.prepare(`
    INSERT INTO workspace_sessions (id, user_id, token_hash, expires_at, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, userId, tokenHash, expiresAt, timestamp, timestamp, timestamp).run();
  return id;
}

export function touchSession(db: D1Database, sessionId: string, timestamp = new Date().toISOString()) {
  const cutoff = new Date(Date.parse(timestamp) - 5 * 60 * 1000).toISOString();
  return db.prepare(`UPDATE workspace_sessions SET updated_at = ?, last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)`).bind(timestamp, timestamp, sessionId, cutoff);
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
