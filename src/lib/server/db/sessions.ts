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

export async function createSession(db: D1Database, userId: string) {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  await db.prepare(`INSERT INTO workspace_sessions (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .bind(id, userId, timestamp, timestamp).run();
  return id;
}

export function touchSession(db: D1Database, sessionId: string, timestamp = new Date().toISOString()) {
  return db.prepare(`UPDATE workspace_sessions SET updated_at = ? WHERE id = ?`).bind(timestamp, sessionId);
}

export async function deleteSession(db: D1Database, sessionId: string) {
  await db.prepare(`DELETE FROM workspace_sessions WHERE id = ?`).bind(sessionId).run();
}
