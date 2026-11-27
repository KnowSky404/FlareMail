import { expect, test } from 'bun:test';
import { openMcpTestDatabase } from './d1.test-fixture';
import {
  accessLifetime, activeAccess, addPendingGrant, consumeConsent, consumeExchange, credentialDigest, nowSeconds,
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
  database.query('UPDATE mcp_credentials SET expires_at = ? WHERE digest = ?').run(nowSeconds() - 1, digest);
  expect(await activeAccess(db, a, digest)).toBeNull();
  const refresh = await credentialDigest('refresh1');
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
});
