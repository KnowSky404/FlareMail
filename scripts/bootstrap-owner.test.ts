import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { buildLocalCredentialResetStatements, extractD1Rows, selectOwnerForBootstrap } from './bootstrap-owner';

describe('controlled Owner bootstrap selection', () => {
  test('keeps a mapped Owner stable when credentials are reissued', () => {
    expect(selectOwnerForBootstrap({
      userIds: ['owner-1', 'old-user'], mappedOwnerId: 'owner-1', requestedOwnerId: null, generatedOwnerId: 'new-id'
    })).toEqual({ userId: 'owner-1', createUser: false });
    expect(() => selectOwnerForBootstrap({
      userIds: ['owner-1', 'old-user'], mappedOwnerId: 'owner-1', requestedOwnerId: 'old-user', generatedOwnerId: 'new-id'
    })).toThrow(/separate ownership migration/u);
  });

  test('selects a sole legacy user, creates a new stable Owner, and never guesses across multiple users', () => {
    expect(selectOwnerForBootstrap({
      userIds: ['legacy-owner'], mappedOwnerId: null, requestedOwnerId: null, generatedOwnerId: 'new-id'
    })).toEqual({ userId: 'legacy-owner', createUser: false });
    expect(selectOwnerForBootstrap({
      userIds: [], mappedOwnerId: null, requestedOwnerId: null, generatedOwnerId: 'new-id'
    })).toEqual({ userId: 'new-id', createUser: true });
    expect(selectOwnerForBootstrap({
      userIds: ['legacy-a', 'legacy-b'], mappedOwnerId: null, requestedOwnerId: 'legacy-b', generatedOwnerId: 'new-id'
    })).toEqual({ userId: 'legacy-b', createUser: false });
    expect(() => selectOwnerForBootstrap({
      userIds: ['legacy-a', 'legacy-b'], mappedOwnerId: null, requestedOwnerId: null, generatedOwnerId: 'new-id'
    })).toThrow(/choose one explicitly/u);
  });

  test('parses Wrangler JSON rows without exposing fields beyond the caller query', () => {
    expect(extractD1Rows('[{"results":[{"id":"owner-1"}],"success":true}]')).toEqual([{ id: 'owner-1' }]);
  });

  test('password reset revokes local sessions and updates only the selected Owner credential', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE workspace_sessions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, auth_method TEXT NOT NULL,
        revoked_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE workspace_auth_credentials (
        user_id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
        credential_hash TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO workspace_sessions VALUES ('local-1', 'owner-1', 'local', NULL, 'old');
      INSERT INTO workspace_sessions VALUES ('access-1', 'owner-1', 'cloudflare-access', NULL, 'old');
      INSERT INTO workspace_sessions VALUES ('other-1', 'other-owner', 'local', NULL, 'old');
      INSERT INTO workspace_auth_credentials VALUES ('owner-1', 'old-name', 'old-hash', 'old');
    `);

    for (const statement of buildLocalCredentialResetStatements({
      userId: 'owner-1',
      username: 'new-name',
      credentialHash: "hash'with-quote",
      timestamp: '2026-09-20T12:00:00.000Z'
    })) db.exec(statement);

    expect(db.query('SELECT id, revoked_at FROM workspace_sessions ORDER BY id').all()).toEqual([
      { id: 'access-1', revoked_at: null },
      { id: 'local-1', revoked_at: '2026-09-20T12:00:00.000Z' },
      { id: 'other-1', revoked_at: null }
    ]);
    expect(db.query('SELECT user_id, username, credential_hash FROM workspace_auth_credentials').all())
      .toEqual([{ user_id: 'owner-1', username: 'new-name', credential_hash: "hash'with-quote" }]);
    db.close();
  });
});
