import type { CloudflareEnv } from '$lib/server/cloudflare';
import {
  demoCredentials, legacyProfileMatch, legacySeedDraftIds, legacySeedMessageIds, legacySeedSentIds,
  mapUserRowToProfile, mockProfile, nowIso, type WorkspaceCapabilities, type WorkspaceUserRow
} from '$lib/server/workspace/shared';

const userSelect = `id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence`;

export async function findUserByLogin(db: D1Database, loginEmail: string) {
  return db.prepare(`SELECT ${userSelect} FROM workspace_users WHERE login_email = ?`).bind(loginEmail).first<WorkspaceUserRow>();
}

export async function findUserById(db: D1Database, userId: string) {
  return db.prepare(`SELECT ${userSelect} FROM workspace_users WHERE id = ?`).bind(userId).first<WorkspaceUserRow>();
}

function isLegacySeedProfile(row: WorkspaceUserRow) {
  return row.name === legacyProfileMatch.name && row.role === legacyProfileMatch.role && row.email === legacyProfileMatch.email &&
    row.company === legacyProfileMatch.company && row.location === legacyProfileMatch.location && row.timezone === legacyProfileMatch.timezone &&
    Boolean(row.forwarding_enabled) === legacyProfileMatch.forwardingEnabled && row.signature === legacyProfileMatch.signature;
}

export async function normalizeLegacyDemoUserProfile(db: D1Database, user: WorkspaceUserRow) {
  if (!isLegacySeedProfile(user)) return user;
  const profile = mockProfile;
  await updateUserProfile(db, user.id, profile);
  return { ...user, name: profile.name, role: profile.role, email: profile.email, company: profile.company, location: profile.location,
    timezone: profile.timezone, forwarding_enabled: profile.forwardingEnabled ? 1 : 0, signature: profile.signature };
}

export async function cleanupLegacyWorkspaceSeedData(db: D1Database, userId: string, capabilities: WorkspaceCapabilities) {
  const statements = [db.prepare(`DELETE FROM workspace_messages WHERE user_id = ? AND (id IN (?, ?, ?, ?, ?) OR id LIKE 'inbox-live-%')`).bind(userId, ...legacySeedMessageIds)];
  if (capabilities.drafts) statements.push(db.prepare(`DELETE FROM workspace_drafts WHERE user_id = ? AND id = ?`).bind(userId, ...legacySeedDraftIds));
  if (capabilities.outboundStatuses) statements.push(db.prepare(`DELETE FROM workspace_outbound_statuses WHERE user_id = ? AND message_id IN (?, ?)`).bind(userId, ...legacySeedSentIds));
  if (capabilities.outboundReceipts) statements.push(db.prepare(`DELETE FROM workspace_outbound_receipts WHERE user_id = ? AND message_id IN (?, ?)`).bind(userId, ...legacySeedSentIds));
  if (capabilities.outboundEvents) statements.push(db.prepare(`DELETE FROM workspace_outbound_events WHERE user_id = ? AND message_id IN (?, ?)`).bind(userId, ...legacySeedSentIds));
  await db.batch(statements);
}

export async function ensureDemoUser(db: D1Database, capabilities: WorkspaceCapabilities) {
  let user = await findUserByLogin(db, demoCredentials.email);
  if (!user) {
    const id = crypto.randomUUID();
    const profile = mockProfile;
    const timestamp = nowIso();
    await db.prepare(`
      INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, demoCredentials.email, profile.name, profile.role, profile.email, profile.company, profile.location, profile.timezone,
      profile.forwardingEnabled ? 1 : 0, profile.signature, 0, timestamp, timestamp).run();
    user = await findUserById(db, id);
  }
  if (!user) throw new Error('无法初始化演示用户。');
  user = await normalizeLegacyDemoUserProfile(db, user);
  await cleanupLegacyWorkspaceSeedData(db, user.id, capabilities);
  return user;
}

export async function updateUserProfile(db: D1Database, userId: string, profile: ReturnType<typeof mapUserRowToProfile>) {
  await db.prepare(`
    UPDATE workspace_users SET name = ?, role = ?, email = ?, company = ?, location = ?, timezone = ?, forwarding_enabled = ?, signature = ?, updated_at = ?
    WHERE id = ?
  `).bind(profile.name, profile.role, profile.email, profile.company, profile.location, profile.timezone,
    profile.forwardingEnabled ? 1 : 0, profile.signature, nowIso(), userId).run();
}

export type { CloudflareEnv };
