import { mapUserRowToProfile, nowIso, type WorkspaceAuthUserRow, type WorkspaceUserRow } from '$lib/server/workspace/shared';

const userSelect = `id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence`;

export async function findUserByLogin(db: D1Database, loginEmail: string) {
  return db.prepare(`SELECT ${userSelect} FROM workspace_users WHERE lower(login_email) = lower(?)`)
    .bind(loginEmail).first<WorkspaceUserRow>();
}

export async function findAuthUserByLogin(db: D1Database, loginEmail: string) {
  return db.prepare(`
    SELECT ${userSelect}, credential_hash, credential_updated_at
    FROM workspace_users
    WHERE lower(login_email) = lower(?)
  `).bind(loginEmail).first<WorkspaceAuthUserRow>();
}

export async function findUserById(db: D1Database, userId: string) {
  return db.prepare(`SELECT ${userSelect} FROM workspace_users WHERE id = ?`).bind(userId).first<WorkspaceUserRow>();
}

export async function updateUserProfile(db: D1Database, userId: string, profile: ReturnType<typeof mapUserRowToProfile>) {
  await db.prepare(`
    UPDATE workspace_users SET name = ?, role = ?, email = ?, company = ?, location = ?, timezone = ?, forwarding_enabled = ?, signature = ?, updated_at = ?
    WHERE id = ?
  `).bind(profile.name, profile.role, profile.email, profile.company, profile.location, profile.timezone,
    profile.forwardingEnabled ? 1 : 0, profile.signature, nowIso(), userId).run();
}
