import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import type { WorkspaceContext } from './shared';
import { buildWorkspaceBackHref, readWorkspaceMessage } from './reader';

class Statement {
  private values: SQLQueryBindings[] = [];

  constructor(private readonly db: Database, private readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values as SQLQueryBindings[];
    return this as unknown as D1PreparedStatement;
  }

  async first<T>() {
    return (this.db.query(this.sql).get(...this.values) as T | null) ?? null;
  }
}

class D1 {
  constructor(readonly db: Database) {}

  prepare(sql: string) {
    return new Statement(this.db, sql) as unknown as D1PreparedStatement;
  }
}

const profile = {
  name: 'Owner', role: 'Owner', email: 'owner@example.test', company: '', location: '', timezone: 'UTC',
  forwardingEnabled: false, signature: ''
};

const session = (userId: string): WorkspaceContext => ({
  id: `session-${userId}`,
  userId,
  storage: 'd1',
  incomingSequence: 0,
  createdAt: '',
  updatedAt: '',
  profile
});

const databases: Database[] = [];

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
  db.query(`INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone)
    VALUES ('user-1', 'owner@example.test', 'Owner', 'Owner', 'owner@example.test', '', '', 'UTC'),
      ('user-2', 'other@example.test', 'Other', 'Member', 'other@example.test', '', '', 'UTC')`).run();
  db.query(`INSERT INTO workspace_messages
    (id, user_id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at, labels_json)
    VALUES ('workspace-1', 'user-1', 'sent', 'Owner', 'owner@example.test', 'Reader', 'reader@example.test',
      'Workspace subject', 'Workspace preview', 'private workspace body', '2026-09-12T12:00:00.000Z', '[]')`).run();
  db.query(`INSERT INTO email_messages
    (id, message_id, "from", "to", subject, "timestamp", snippet, text_body, html_body, raw_key, raw_size, dedupe_key, owner_user_id)
    VALUES ('inbound-1', '<inbound@example.test>', 'Sender <sender@example.test>', 'owner@example.test',
      'Inbound subject', '2026-09-12T13:00:00.000Z', 'Inbound preview', 'private inbound body', '<p>private</p>',
      'raw/inbound-1', 20, 'dedupe-inbound-1', 'user-1')`).run();
  return { db, env: { DB: new D1(db) } as unknown as CloudflareEnv };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe('standalone message reader', () => {
  test('returns owner-scoped metadata without exposing the canonical body', async () => {
    const value = fixture();
    const workspace = await readWorkspaceMessage(value.env, session('user-1'), 'workspace-1');
    const inbound = await readWorkspaceMessage(value.env, session('user-1'), 'email:inbound-1');

    expect(workspace).toMatchObject({ id: 'workspace-1', source: 'workspace', subject: 'Workspace subject', body: '' });
    expect(inbound).toMatchObject({ id: 'email:inbound-1', source: 'inbound', subject: 'Inbound subject', body: '' });
  });

  test('unifies missing, foreign, and deleted messages as hidden', async () => {
    const value = fixture();
    expect(await readWorkspaceMessage(value.env, session('user-2'), 'workspace-1')).toBeNull();
    expect(await readWorkspaceMessage(value.env, session('user-1'), 'missing')).toBeNull();

    value.db.query(`UPDATE workspace_messages SET deleted_at = '2026-09-12T14:00:00.000Z' WHERE id = 'workspace-1'`).run();
    value.db.query(`INSERT INTO workspace_email_states (id, user_id, email_message_id, deleted_at)
      VALUES ('state-1', 'user-1', 'inbound-1', '2026-09-12T14:00:00.000Z')`).run();

    expect(await readWorkspaceMessage(value.env, session('user-1'), 'workspace-1')).toBeNull();
    expect(await readWorkspaceMessage(value.env, session('user-1'), 'email:inbound-1')).toBeNull();
  });

  test('preserves only the safe workspace query contract in the return link', () => {
    const url = new URL('https://flaremail.test/messages/workspace-1?folder=sent&q=from%3Areader%40example.test&filter=starred&message=other&body=private&token=secret');
    const message = {
      id: 'workspace-1', folder: 'sent', source: 'workspace', archivedAt: null
    } as Parameters<typeof buildWorkspaceBackHref>[1];

    expect(buildWorkspaceBackHref(url, message)).toBe('/?folder=sent&message=workspace-1&q=from%3Areader%40example.test&filter=starred');
    expect(buildWorkspaceBackHref(url, message)).not.toContain('body=');
    expect(buildWorkspaceBackHref(url, message)).not.toContain('token=');
  });
});
