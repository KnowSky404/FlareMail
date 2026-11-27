import { defaultMcpScopes, scopesFromMask } from '$lib/domain/mail/mcp';

export const accessLifetime = 10 * 60;
export const grantLifetime = 30 * 24 * 60 * 60;
export const auditLimit = 20_000;
export const auditLifetime = 30 * 24 * 60 * 60;
export const codeLifetime = 10 * 60;

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function credentialDigest(token: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface Policy {
  enabled: number;
  scopes: number;
  revision: number;
}

interface Grant {
  id: string;
  owner_id: string;
  issuer: string;
  client_id: string;
  client_name: string;
  scopes: number;
  authorized_at: number;
  expires_at: number;
  activated_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

export type AuditOutcome = 'ok' | 'denied' | 'invalid_input' | 'not_found' | 'limited' | 'unavailable';

const policySql = `
  SELECT COALESCE(p.enabled, 0) AS enabled, COALESCE(p.scopes, ${defaultMcpScopes}) AS scopes,
    COALESCE(p.revision, 0) AS revision
  FROM workspace_owner AS o
  JOIN workspace_users AS u ON u.id = o.user_id
  LEFT JOIN mcp_policies AS p ON p.owner_id = o.user_id
  WHERE o.singleton = 1`;

export function ownerPolicy(db: D1Database, ownerId?: string) {
  return db.prepare(policySql + (ownerId ? ' AND o.user_id = ?' : ''))
    .bind(...(ownerId ? [ownerId] : [])).first<Policy>();
}

export async function updateMcpPolicy(db: D1Database, ownerId: string, enabled: boolean, scopes: number) {
  const result = await db.batch([
    db.prepare(`INSERT INTO mcp_policies (owner_id, enabled, scopes, revision)
      SELECT user_id, ?, ?, 1 FROM workspace_owner WHERE singleton = 1 AND user_id = ?
      ON CONFLICT(owner_id) DO UPDATE SET enabled = excluded.enabled, scopes = excluded.scopes,
        revision = mcp_policies.revision + 1`).bind(Number(enabled), scopes, ownerId),
    db.prepare(`UPDATE mcp_grants SET scopes = scopes & ?,
      revoked_at = CASE WHEN ? = 0 OR (scopes & ?) = 0 THEN COALESCE(revoked_at, ?) ELSE revoked_at END
      WHERE owner_id = ? AND revoked_at IS NULL AND expires_at > ?`)
      .bind(scopes, Number(enabled), scopes, nowSeconds(), ownerId, nowSeconds())
  ]);
  return result[0]?.meta.changes === 1;
}

export async function revokeMcpGrants(db: D1Database, ownerId: string, grantId?: string) {
  const now = nowSeconds();
  if (grantId) {
    await db.prepare('UPDATE mcp_grants SET revoked_at = ? WHERE owner_id = ? AND id = ? AND revoked_at IS NULL')
      .bind(now, ownerId, grantId).run();
    return;
  }
  await db.batch([
    db.prepare('UPDATE mcp_policies SET revision = revision + 1 WHERE owner_id = ?').bind(ownerId),
    db.prepare('UPDATE mcp_grants SET revoked_at = ? WHERE owner_id = ? AND revoked_at IS NULL').bind(now, ownerId)
  ]);
}

export async function startConsent(db: D1Database, digest: string, owner: string, revision: number) {
  await db.prepare('INSERT INTO mcp_consent_nonces (digest, owner_id, revision, expires_at) VALUES (?, ?, ?, ?)')
    .bind(digest, owner, revision, nowSeconds() + codeLifetime).run();
}

export async function consumeConsent(db: D1Database, digest: string, owner: string, revision: number) {
  const now = nowSeconds();
  const result = await db.prepare(`UPDATE mcp_consent_nonces SET consumed_at = ? WHERE digest = ?
    AND owner_id = ? AND revision = ? AND expires_at > ? AND consumed_at IS NULL`)
    .bind(now, digest, owner, revision, now).run();
  return result.meta.changes === 1;
}

export async function addPendingGrant(db: D1Database, input: {
  id: string;
  owner: string;
  issuer: string;
  client: string;
  name: string;
  scopes: number;
  revision: number;
  code: string;
}) {
  const now = nowSeconds();
  const result = await db.batch([
    db.prepare(`INSERT INTO mcp_grants (id, owner_id, issuer, client_id, client_name, scopes, authorized_at, expires_at)
      SELECT ?, p.owner_id, ?, ?, ?, ?, ?, ?
      FROM mcp_policies AS p JOIN workspace_owner AS o ON o.user_id = p.owner_id AND o.singleton = 1
      WHERE p.owner_id = ? AND p.enabled = 1 AND p.revision = ? AND (p.scopes & ?) = ?
        AND (SELECT COUNT(*) FROM mcp_grants g WHERE g.owner_id = p.owner_id AND g.revoked_at IS NULL AND g.expires_at > ?) < 100`)
      .bind(input.id, input.issuer, input.client, input.name, input.scopes, now, now + codeLifetime,
        input.owner, input.revision, input.scopes, input.scopes, now),
    db.prepare(`INSERT INTO mcp_credentials (digest, grant_id, kind, issued_at_ms, expires_at)
      SELECT ?, id, 'code', ?, expires_at FROM mcp_grants WHERE id = ?`)
      .bind(await credentialDigest(input.code), Date.now(), input.id)
  ]);
  return result[0]?.meta.changes === 1;
}

const activeGrantSql = (extraJoin = '') => `
  FROM mcp_grants AS g
  JOIN workspace_owner AS o ON o.user_id = g.owner_id AND o.singleton = 1
  JOIN mcp_policies AS p ON p.owner_id = g.owner_id AND p.enabled = 1
  ${extraJoin}
  WHERE g.id = ? AND g.owner_id = ? AND g.issuer = ? AND g.client_id = ?
    AND g.revoked_at IS NULL AND g.expires_at > ? AND (g.scopes & p.scopes) > 0`;

export interface GrantKey {
  id: string;
  owner: string;
  issuer: string;
  client: string;
}

const grantArgs = (grant: GrantKey, now: number) => [grant.id, grant.owner, grant.issuer, grant.client, now] as const;

const activeAccessSql = `${activeGrantSql()}
    AND g.activated_at IS NOT NULL AND EXISTS (SELECT 1 FROM mcp_credentials
      WHERE digest = ? AND grant_id = g.id AND kind = 'access' AND consumed_at IS NULL AND expires_at > ?)`;

export async function activeAccess(db: D1Database, grant: GrantKey, digest: string) {
  return db.prepare(`SELECT g.id, g.owner_id, g.client_name, (g.scopes & p.scopes) AS scopes ${activeAccessSql}`)
    .bind(...grantArgs(grant, nowSeconds()), digest, nowSeconds()).first<Pick<Grant, 'id' | 'owner_id' | 'client_name' | 'scopes'>>();
}

export function inspectExchange(db: D1Database, grant: GrantKey, kind: 'code' | 'refresh', digest: string) {
  return db.prepare(`SELECT c.issued_at_ms, c.consumed_at, (g.scopes & p.scopes) AS scopes
    ${activeGrantSql('JOIN mcp_credentials AS c ON c.grant_id = g.id')}
    AND c.digest = ? AND c.kind = ? AND c.expires_at > ?`)
    .bind(...grantArgs(grant, nowSeconds()), digest, kind, nowSeconds())
    .first<{ issued_at_ms: number; consumed_at: number | null; scopes: number }>();
}

export async function consumeExchange(db: D1Database, grant: GrantKey, kind: 'code' | 'refresh', digest: string, requestedMask = 7) {
  const now = nowSeconds();
  const ops = await db.batch([
    db.prepare(`UPDATE mcp_credentials SET consumed_at = ? WHERE digest = ? AND kind = ?
      AND grant_id = ? AND expires_at > ? AND consumed_at IS NULL
      AND EXISTS (SELECT 1 ${activeGrantSql()} AND (g.scopes & p.scopes & ?) > 0) RETURNING digest`)
      .bind(now, digest, kind, grant.id, now, ...grantArgs(grant, now), requestedMask),
    db.prepare(`SELECT (g.scopes & p.scopes & ?) AS scopes ${activeGrantSql()}`)
      .bind(requestedMask, ...grantArgs(grant, now))
  ]);
  const policy = ops[1]?.results[0] as { scopes: number } | undefined;
  return ops[0]?.results.length === 1 ? policy?.scopes ?? 0 : 0;
}

export async function revokeReplayedExchange(db: D1Database, client: string, issuer: string, kind: 'code' | 'refresh', digest: string) {
  const now = nowSeconds();
  await db.prepare(`UPDATE mcp_grants SET revoked_at = ?
    WHERE issuer = ? AND client_id = ? AND revoked_at IS NULL AND id IN (
      SELECT grant_id FROM mcp_credentials WHERE digest = ? AND kind = ? AND expires_at > ? AND consumed_at IS NOT NULL
    )`).bind(now, issuer, client, digest, kind, now).run();
}

export async function recordTokenIssue(db: D1Database, grant: GrantKey, input: {
  kind: 'code' | 'refresh';
  access: string;
  refresh: string;
  accessTtl: number;
}) {
  const issuedAt = Date.now();
  const now = Math.floor(issuedAt / 1000);
  const access = await credentialDigest(input.access);
  const refresh = await credentialDigest(input.refresh);
  const ops = await db.batch([
    db.prepare(`UPDATE mcp_grants SET activated_at = ?, expires_at = ?
      WHERE activated_at IS NULL AND ? = 'code' AND id IN (SELECT g.id ${activeGrantSql()})`)
      .bind(now, now + grantLifetime, input.kind, ...grantArgs(grant, now)),
    // Keep the spent digest to reconcile provider replay revocation for the grant lifetime.
    db.prepare(`UPDATE mcp_credentials SET expires_at = ?
      WHERE grant_id = ? AND kind = 'code' AND consumed_at IS NOT NULL AND ? = 'code'
      AND EXISTS (SELECT 1 ${activeGrantSql()} AND g.activated_at = ?)`)
      .bind(now + grantLifetime, grant.id, input.kind, ...grantArgs(grant, now), now),
    db.prepare(`INSERT INTO mcp_credentials (digest, grant_id, kind, issued_at_ms, expires_at)
      SELECT ?, g.id, 'access', ?, MIN(?, g.expires_at) ${activeGrantSql()} AND g.activated_at IS NOT NULL`)
      .bind(access, issuedAt, now + input.accessTtl, ...grantArgs(grant, now)),
    db.prepare(`INSERT INTO mcp_credentials (digest, grant_id, kind, issued_at_ms, expires_at)
      SELECT ?, g.id, 'refresh', ?, g.expires_at ${activeGrantSql()} AND g.activated_at IS NOT NULL`)
      .bind(refresh, issuedAt, ...grantArgs(grant, now))
  ]);
  return ops[2]?.meta.changes === 1 && ops[3]?.meta.changes === 1;
}

export async function revokeIssuedCredential(db: D1Database, issuer: string, client: string, digest: string) {
  const now = nowSeconds();
  await db.batch([
    db.prepare(`UPDATE mcp_grants SET revoked_at = ?
      WHERE issuer = ? AND client_id = ? AND revoked_at IS NULL AND id IN (
        SELECT grant_id FROM mcp_credentials WHERE digest = ? AND kind = 'refresh' AND expires_at > ?
      )`).bind(now, issuer, client, digest, now),
    db.prepare(`UPDATE mcp_credentials SET consumed_at = ?
      WHERE digest = ? AND kind = 'access' AND expires_at > ? AND grant_id IN (
        SELECT id FROM mcp_grants WHERE issuer = ? AND client_id = ?
      )`).bind(now, digest, now, issuer, client)
  ]);
}

export async function recordMcpActivity(db: D1Database, grant: Pick<Grant, 'id' | 'owner_id' | 'client_name'>,
  requestId: string, tool: string, outcome: AuditOutcome, elapsedMs: number,
  access?: { key: GrantKey; digest: string; scopeBit: number }) {
  const now = nowSeconds();
  const resolvedOutcome = access
    ? `CASE WHEN EXISTS (SELECT 1 ${activeAccessSql} AND (g.scopes & p.scopes & ?) <> 0) THEN ? ELSE 'denied' END`
    : '?';
  const rows = await db.batch<{ outcome: AuditOutcome }>([
    db.prepare('DELETE FROM mcp_activity WHERE rowid <= (SELECT MAX(rowid) - ? FROM mcp_activity)').bind(auditLimit - 1),
    db.prepare(`UPDATE mcp_grants SET last_used_at = MAX(COALESCE(last_used_at, 0), ?) WHERE id = ?`).bind(now, grant.id),
    db.prepare(`INSERT INTO mcp_activity (id, owner_id, grant_id, client_name, tool, outcome, duration_ms, called_at)
      VALUES (?, ?, ?, ?, ?, ${resolvedOutcome}, ?, ?) RETURNING outcome`)
      .bind(requestId, grant.owner_id, grant.id, grant.client_name, tool,
        ...(access ? [...grantArgs(access.key, now), access.digest, now, access.scopeBit] : []),
        outcome, Math.round(elapsedMs), now)
  ]);
  return rows[2]?.results[0]?.outcome;
}

export function hasMcpTables(db: D1Database) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mcp_policies'").first();
}

export async function cleanupMcpRecords(db: D1Database, now = nowSeconds()) {
  // The compatible schema-42 runtime can be deployed before optional MCP tables exist.
  if (!(await hasMcpTables(db))) return;
  await db.batch([
    db.prepare('DELETE FROM mcp_activity WHERE called_at < ?').bind(now - auditLifetime),
    db.prepare('DELETE FROM mcp_consent_nonces WHERE digest IN (SELECT digest FROM mcp_consent_nonces WHERE expires_at <= ? LIMIT 5000)').bind(now),
    db.prepare('DELETE FROM mcp_credentials WHERE digest IN (SELECT digest FROM mcp_credentials WHERE expires_at <= ? LIMIT 5000)').bind(now),
    db.prepare('DELETE FROM mcp_grants WHERE id IN (SELECT id FROM mcp_grants WHERE expires_at < ? OR revoked_at < ? LIMIT 5000)')
      .bind(now - auditLifetime, now - auditLifetime)
  ]);
}

export async function listMcpGrants(db: D1Database, owner: string) {
  const now = nowSeconds();
  const rows = await db.prepare(`SELECT * FROM mcp_grants WHERE owner_id = ?
    AND (expires_at > ? OR revoked_at > ?)
    ORDER BY (revoked_at IS NULL AND expires_at > ?) DESC, authorized_at DESC, id DESC LIMIT 100`)
    .bind(owner, now - auditLifetime, now - auditLifetime, now).all<Grant>();
  return rows.results.map((row) => ({
    id: row.id, clientId: row.client_id.slice(0, 4) + '…' + row.client_id.slice(-4), name: row.client_name,
    scopes: scopesFromMask(row.scopes), authorizedAt: row.authorized_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at,
    status: row.revoked_at !== null ? 'revoked' : row.expires_at <= now ? 'expired' : row.activated_at === null ? 'pending' : 'active'
  }));
}

export async function listMcpActivity(db: D1Database, owner: string, cursor: { time: number; id: string } | null) {
  const statement = db.prepare(`SELECT id, client_name AS client, tool, outcome, duration_ms AS durationMs, called_at AS time
    FROM mcp_activity WHERE owner_id = ? AND called_at >= ? ${cursor ? 'AND (called_at, id) < (?, ?)' : ''}
    ORDER BY called_at DESC, id DESC LIMIT 21`);
  const rows = (await statement.bind(owner, nowSeconds() - auditLifetime, ...(cursor ? [cursor.time, cursor.id] : []))
    .all<{ id: string; client: string; tool: string; outcome: AuditOutcome; durationMs: number; time: number }>()).results;
  const items = rows.slice(0, 20);
  const last = items.at(-1);
  return { items, next: rows.length > 20 && last ? { time: last.time, id: last.id } : null };
}
