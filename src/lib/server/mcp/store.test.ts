import { expect, test } from 'bun:test';
import { openMcpTestDatabase } from './d1.test-fixture';
import {
  accessLifetime, activeAccess, addPendingGrant, auditLimit, cleanupMcpRecords, codeLifetime, consumeConsent, consumeExchange, credentialDigest, listMcpGrants, nowSeconds, recordMcpActivity,
  ownerPolicy, recordTokenIssue, revokeIssuedCredential, revokeMcpGrants, revokeReplayedExchange, startConsent, updateMcpPolicy
} from './store';

test('D1 gates OAuth grants across consent replay, token expiry, narrowing, revocations and Owner change', async () => {
  using fixture = openMcpTestDatabase();
  const { database, db } = fixture;
  const key = { id: 'grant1', owner: 'owner', issuer: 'https://mcp.example.test', client: 'client' };
  expect(await ownerPolicy(db, 'owner')).toEqual({ enabled: 0, scopes: 3, revision: 0 });
  expect(await updateMcpPolicy(db, 'other', true, 7)).toBe(false);
  expect(await updateMcpPolicy(db, 'owner', true, 7)).toBe(true);
  const policy = (await ownerPolicy(db, 'owner'))!;
  await startConsent(db, 'nonce', 'owner', policy.revision);
  expect(await consumeConsent(db, 'nonce', 'other', policy.revision)).toBe(false);
  expect(await consumeConsent(db, 'nonce', 'owner', policy.revision + 1)).toBe(false);
  expect(await consumeConsent(db, 'nonce', 'owner', policy.revision)).toBe(true);
  expect(await consumeConsent(db, 'nonce', 'owner', policy.revision)).toBe(false);

  async function issue(grantId: string, code: string, access: string, refresh: string) {
    const grant = { ...key, id: grantId };
    const revision = (await ownerPolicy(db, 'owner'))!.revision;
    expect(await addPendingGrant(db, { ...grant, name: 'Synthetic', revision, code, scopes: 7 })).toBe(true);
    expect((await listMcpGrants(db, 'owner')).find((item) => item.id === grantId)?.status).toBe('pending');
    const digest = await credentialDigest(code);
    expect(await consumeExchange(db, { ...grant, issuer: 'https://other.example.test' }, 'code', digest)).toBe(0);
    expect(await consumeExchange(db, grant, 'code', digest)).toBe(7);
    expect(await consumeExchange(db, grant, 'code', digest)).toBe(0);
    expect(await recordTokenIssue(db, grant, { kind: 'code', access, refresh, accessTtl: accessLifetime })).toBe(true);
    return grant;
  }

  const a = await issue('grant1', 'code1', 'access1', 'refresh1');
  const b = await issue('grant2', 'code2', 'access2', 'refresh2');
  const digest = await credentialDigest('access1');
  expect((await activeAccess(db, a, digest))?.scopes).toBe(7);
  await updateMcpPolicy(db, 'owner', true, 3);
  await updateMcpPolicy(db, 'owner', true, 7);
  expect((await activeAccess(db, a, digest))?.scopes).toBe(3);
  expect(await recordMcpActivity(db, { id: a.id, owner_id: 'owner', client_name: 'Synthetic' },
    'audit-denied', 'list_attachments', 'ok', 1, { key: a, digest, scopeBit: 4 })).toBe('denied');
  expect(await recordMcpActivity(db, { id: a.id, owner_id: 'owner', client_name: 'Synthetic' },
    'audit-allowed', 'search', 'ok', 1, { key: a, digest, scopeBit: 1 })).toBe('ok');
  database.query('UPDATE mcp_credentials SET expires_at = ? WHERE digest = ?').run(nowSeconds() - 1, digest);
  expect(await activeAccess(db, a, digest)).toBeNull();
  const refresh = await credentialDigest('refresh1');
  expect(await consumeExchange(db, a, 'refresh', refresh, 4)).toBe(0);
  expect(await consumeExchange(db, a, 'refresh', refresh)).toBe(3);
  expect(await recordTokenIssue(db, a, { kind: 'refresh', access: 'access3', refresh: 'refresh3', accessTtl: accessLifetime })).toBe(true);
  await revokeReplayedExchange(db, 'client', key.issuer, 'refresh', refresh);
  expect(await activeAccess(db, a, await credentialDigest('access3'))).toBeNull();
  expect(await consumeExchange(db, a, 'refresh', await credentialDigest('refresh3'))).toBe(0);
  const secondAccess = await credentialDigest('access2');
  expect(await activeAccess(db, b, secondAccess)).not.toBeNull();
  await revokeIssuedCredential(db, key.issuer, 'wrong-client', secondAccess);
  expect(await activeAccess(db, b, secondAccess)).not.toBeNull();
  database.query("UPDATE workspace_owner SET user_id = 'other'").run();
  expect(await activeAccess(db, b, secondAccess)).toBeNull();
  database.query("UPDATE workspace_owner SET user_id = 'owner'").run();
  await revokeMcpGrants(db, 'owner', b.id);
  expect(await activeAccess(db, b, secondAccess)).toBeNull();

  const c = await issue('grant3', 'code3', 'access4', 'refresh4');
  const beforeDisable = (await ownerPolicy(db, 'owner'))!.revision;
  await updateMcpPolicy(db, 'owner', false, 7);
  await updateMcpPolicy(db, 'owner', true, 7);
  expect(await activeAccess(db, c, await credentialDigest('access4'))).toBeNull();
  expect(await addPendingGrant(db, { ...key, id: 'stale', name: 'Synthetic', code: 'stale', scopes: 1, revision: beforeDisable })).toBe(false);

  const d = await issue('grant4', 'code4', 'access5', 'refresh5');
  await cleanupMcpRecords(db, nowSeconds() + codeLifetime + 1);
  await revokeReplayedExchange(db, 'client', key.issuer, 'code', await credentialDigest('code4'));
  expect((await listMcpGrants(db, 'owner')).find(({ id }) => id === d.id)?.status).toBe('revoked');
});

test('caps audit size when traffic outpaces cleanup and prunes retained expired records', async () => {
  using fixture = openMcpTestDatabase();
  const { db, database } = fixture;
  const now = nowSeconds();
  database.query(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ?)
    INSERT INTO mcp_activity (id, owner_id, grant_id, client_name, tool, outcome, duration_ms, called_at)
    SELECT 'event-' || i, 'owner', 'grant', 'Synthetic', 'search', 'ok', 1, ? FROM n`)
    .run(auditLimit, now - 31 * 24 * 60 * 60);
  await recordMcpActivity(db, { id: 'grant', owner_id: 'owner', client_name: 'Synthetic' }, 'latest', 'search', 'ok', 3);
  expect(database.query('SELECT COUNT(*) AS total FROM mcp_activity').get()).toEqual({ total: auditLimit });
  expect(database.query("SELECT id FROM mcp_activity WHERE id = 'event-1'").get()).toBeNull();
  await cleanupMcpRecords(db, now);
  expect(database.query('SELECT id FROM mcp_activity').all()).toEqual([{ id: 'latest' }]);
});
