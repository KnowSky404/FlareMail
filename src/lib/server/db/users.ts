import { mapUserRowToProfile, nowIso, type WorkspaceAuthUserRow, type WorkspaceUserRow } from '$lib/server/workspace/shared';

const userSelect = `id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence`;

export async function findUserByLogin(db: D1Database, loginEmail: string) {
  return db.prepare(`SELECT ${userSelect} FROM workspace_users WHERE lower(login_email) = lower(?)`)
    .bind(loginEmail).first<WorkspaceUserRow>();
}

export async function findAuthUserByLogin(db: D1Database, loginEmail: string) {
  return db.prepare(`
    SELECT ${userSelect}, c.credential_hash, c.updated_at AS credential_updated_at
    FROM workspace_owner AS owner
    JOIN workspace_users AS u ON u.id = owner.user_id
    JOIN workspace_auth_credentials AS c ON c.user_id = u.id
    WHERE owner.singleton = 1 AND lower(c.username) = lower(?)
  `).bind(loginEmail).first<WorkspaceAuthUserRow>();
}

export async function findWorkspaceOwnerId(db: D1Database) {
  const row = await db.prepare(`
    SELECT owner.user_id AS id
    FROM workspace_owner AS owner
    JOIN workspace_users AS u ON u.id = owner.user_id
    WHERE owner.singleton = 1
  `).first<{ id: string }>();
  return row?.id ?? null;
}

export async function hasWorkspaceOwnerCredential(db: D1Database) {
  const row = await db.prepare(`
    SELECT EXISTS (
      SELECT 1
      FROM workspace_owner AS owner
      JOIN workspace_users AS u ON u.id = owner.user_id
      JOIN workspace_auth_credentials AS credential ON credential.user_id = owner.user_id
      WHERE owner.singleton = 1 AND length(credential.credential_hash) > 0
    ) AS configured
  `).first<{ configured: number }>();
  return row?.configured === 1;
}

export async function findUserById(db: D1Database, userId: string) {
  return db.prepare(`SELECT ${userSelect} FROM workspace_users WHERE id = ?`).bind(userId).first<WorkspaceUserRow>();
}

export async function findUserInboundNotificationSettings(db: D1Database, userId: string) {
  return db.prepare(`SELECT id, forwarding_enabled FROM workspace_users WHERE id = ?`)
    .bind(userId).first<{ id: string; forwarding_enabled: number }>();
}

export async function updateUserProfile(db: D1Database, userId: string, profile: ReturnType<typeof mapUserRowToProfile>) {
  await db.prepare(`
    UPDATE workspace_users SET name = ?, role = ?, email = ?, company = ?, location = ?, timezone = ?, forwarding_enabled = ?, signature = ?, updated_at = ?
    WHERE id = ?
  `).bind(profile.name, profile.role, profile.email, profile.company, profile.location, profile.timezone,
    profile.forwardingEnabled ? 1 : 0, profile.signature, nowIso(), userId).run();
}
