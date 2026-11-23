import { describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { hashSessionToken } from '$lib/server/auth/token';
import {
  getWorkspaceSessionCookieName,
  isSecureSessionRequest,
  destroyWorkspaceSession,
  getWorkspaceSession,
  secureWorkspaceSessionCookie,
  sessionCookieOptions,
  workspaceSessionCookie
} from './session';

test('reads the current Owner and token together and touches only due sessions', async () => {
  using database = new Database(':memory:');
  database.exec(await Bun.file(new URL('../../../../schema.sql', import.meta.url)).text());
  database.exec(`
    INSERT INTO workspace_users (id, name, role) VALUES ('owner', 'Owner', 'Owner'), ('other', 'Other', 'Owner');
    INSERT INTO workspace_owner (singleton, user_id) VALUES (1, 'owner');
  `);
  const token = 'test-token';
  const tokenHash = await hashSessionToken(token);
  const old = new Date(Date.now() - 6 * 60_000).toISOString();
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  database.query(`
    INSERT INTO workspace_sessions (id, user_id, token_hash, expires_at, last_seen_at)
    VALUES ('session', 'owner', ?, ?, ?)
  `).run(tokenHash, future, old);
  const operations: string[] = [];
  const env = { DB: { prepare(sql: string) {
    operations.push(sql.trim().split(' ', 1)[0]);
    const statement = database.query(sql);
    return { bind(...args: SQLQueryBindings[]) {
      return { first: async () => statement.get(...args), run: async () => statement.run(...args) };
    } };
  } } } as never;

  const first = await getWorkspaceSession(env, token);
  expect(first).toMatchObject({ id: 'session', userId: 'owner' });
  expect(operations.splice(0)).toEqual(['SELECT', 'UPDATE']);
  expect(await getWorkspaceSession(env, token)).toMatchObject({ id: 'session' });
  expect(operations.splice(0)).toEqual(['SELECT']);

  database.exec("UPDATE workspace_sessions SET last_seen_at = NULL WHERE id = 'session'");
  expect(await getWorkspaceSession(env, token)).toMatchObject({ id: 'session' });
  expect(operations.splice(0)).toEqual(['SELECT', 'UPDATE']);

  database.exec("UPDATE workspace_sessions SET auth_method = 'cloudflare-access', principal_id = 'trusted' WHERE id = 'session'");
  const access = { authMethod: 'cloudflare-access', principalId: 'trusted' } as const;
  expect(await getWorkspaceSession(env, token)).toBeNull();
  expect(await getWorkspaceSession(env, token, { ...access, principalId: 'another' }, 'owner')).toBeNull();
  expect(await getWorkspaceSession(env, token, access, 'other')).toBeNull();
  expect(await getWorkspaceSession(env, token, access, 'owner')).toMatchObject({ id: 'session' });

  database.exec("UPDATE workspace_owner SET user_id = 'other' WHERE singleton = 1");
  expect(await getWorkspaceSession(env, token, access, 'owner')).toBeNull();
  database.exec("UPDATE workspace_owner SET user_id = 'owner' WHERE singleton = 1");
  database.query("UPDATE workspace_sessions SET expires_at = ? WHERE id = 'session'").run(old);
  expect(await getWorkspaceSession(env, token, access, 'owner')).toBeNull();
  database.query("UPDATE workspace_sessions SET expires_at = ?, revoked_at = ? WHERE id = 'session'").run(future, old);
  expect(await getWorkspaceSession(env, token, access, 'owner')).toBeNull();
});

describe('workspace session cookie policy', () => {
  test('reports revocation storage failures instead of claiming logout succeeded', async () => {
    const unavailableDb = { prepare: () => { throw new Error('D1 unavailable'); } };
    expect(await destroyWorkspaceSession({ DB: unavailableDb } as never, 'session-token')).toBe(false);
    expect(await destroyWorkspaceSession(undefined, null)).toBe(true);
  });

  test('uses a Host-prefixed secure cookie on HTTPS', () => {
    expect(isSecureSessionRequest(new URL('https://mail.example.test'))).toBe(true);
    expect(getWorkspaceSessionCookieName(true)).toBe(secureWorkspaceSessionCookie);
    expect(sessionCookieOptions(true, true)).toMatchObject({ path: '/', httpOnly: true, sameSite: 'lax', secure: true });
  });

  test('allows the non-secure cookie only for local HTTP development', () => {
    expect(isSecureSessionRequest(new URL('http://127.0.0.1:8787'))).toBe(false);
    expect(getWorkspaceSessionCookieName(false)).toBe(workspaceSessionCookie);
    expect(sessionCookieOptions(false, false).maxAge).toBeUndefined();
  });

  test('derives cookie security from each incoming request URL', () => {
    expect(isSecureSessionRequest(new URL('https://mail.example.test'))).toBe(true);
    expect(isSecureSessionRequest(new URL('https://mail-secondary.example.test'))).toBe(true);
    expect(isSecureSessionRequest(new URL('http://127.0.0.1:8787'))).toBe(false);
  });
});
