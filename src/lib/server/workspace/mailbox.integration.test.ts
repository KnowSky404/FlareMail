import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SQLQueryBindings } from 'bun:sqlite';
import { loadMailboxPage } from './mailbox';
import type { WorkspaceContext } from './shared';

class TestStatement {
  private bindings: unknown[] = [];

  constructor(private readonly database: Database, private readonly sql: string) {}

  bind(...bindings: unknown[]) {
    this.bindings = bindings;
    return this as unknown as D1PreparedStatement;
  }

  async all<T>() {
    return { results: this.database.query(this.sql).all(...this.bindings as SQLQueryBindings[]) as T[] };
  }

  async first<T>() {
    return (this.database.query(this.sql).get(...this.bindings as SQLQueryBindings[]) ?? null) as T | null;
  }
}

class TestD1 {
  constructor(private readonly database: Database) {}
  prepare(sql: string) {
    return new TestStatement(this.database, sql) as unknown as D1PreparedStatement;
  }
}

const databases: Database[] = [];
afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

function fixture() {
  const database = new Database(':memory:');
  databases.push(database);
  database.exec(readFileSync(resolve(import.meta.dir, '../../../../schema.sql'), 'utf8'));
  const insertWorkspace = database.query(`
    INSERT INTO workspace_messages (
      id, user_id, folder, from_name, from_email, to_name, to_email,
      subject, preview, body, sent_at, labels_json, is_read, is_starred
    ) VALUES (?, 'user-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
  `);
  insertWorkspace.run(
    'inbox-z', 'inbox', 'Zed', 'zed@example.test', 'Ada', 'ada@example.test',
    'Alpha incident', 'preview z', 'body z', '2026-08-13T12:00:00.000Z', 0, 1
  );
  insertWorkspace.run(
    'inbox-a', 'inbox', 'Amy', 'amy@example.test', 'Ada', 'ada@example.test',
    'Routine report', 'preview a', 'body a', '2026-08-13T11:00:00.000Z', 1, 0
  );
  insertWorkspace.run(
    'sent-1', 'sent', 'Ada', 'ada@example.test', 'Bob', 'bob@example.test',
    'Delivery report', 'sent preview', 'sent body', '2026-08-13T09:00:00.000Z', 1, 0
  );
  database.query(`
    INSERT INTO email_messages (
      id, owner_user_id, "from", "to", subject, "timestamp", snippet, raw_key,
      text_body, direction
    ) VALUES ('incoming-1', 'user-1', 'Carol <carol@example.test>', 'ada@example.test',
      'Inbound alert', '2026-08-13T13:00:00.000Z', 'incoming preview', 'raw/incoming-1',
      'incoming body', 'inbound')
  `).run();
  database.query(`
    INSERT INTO workspace_drafts (id, user_id, to_email, subject, body, is_starred, updated_at)
    VALUES ('draft-1', 'user-1', 'd@example.test', 'Draft alert', 'draft body', 1,
      '2026-08-13T10:00:00.000Z')
  `).run();
  database.query(`
    INSERT INTO workspace_delivery_statuses (
      message_id, user_id, status, attempts, idempotency_key, provider, last_event, last_event_at
    ) VALUES ('sent-1', 'user-1', 'delivered', 1, 'idem-1', 'resend', 'email.delivered',
      '2026-08-13T09:10:00.000Z')
  `).run();
  database.query(`
    INSERT INTO workspace_outbound_receipts (
      message_id, user_id, provider, result_kind, remote_status, response_preview,
      last_event, last_event_at
    ) VALUES ('sent-1', 'user-1', 'resend', 'accepted', 200, 'accepted',
      'email.delivered', '2026-08-13T09:10:00.000Z')
  `).run();

  const workspace: WorkspaceContext = {
    id: 'session-1',
    userId: 'user-1',
    profile: {
      name: 'Ada', role: 'Operator', email: 'ada@example.test', company: 'Example',
      location: 'Berlin', timezone: 'Europe/Berlin', forwardingEnabled: true, signature: ''
    },
    incomingSequence: 0,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    storage: 'd1'
  };
  return {
    env: { DB: new TestD1(database) as unknown as D1Database, BUCKET: {} as R2Bucket },
    workspace
  };
}

const query = (folder: 'inbox' | 'sent' | 'drafts', overrides: Record<string, unknown> = {}) => ({
  folder,
  cursor: null,
  limit: 40,
  query: '',
  filter: 'all' as const,
  deliveryStatus: null,
  ...overrides
});

describe('D1 mailbox pages', () => {
  test('merges inbound and workspace messages with a stable opaque cursor', async () => {
    const { env, workspace } = fixture();
    const first = await loadMailboxPage(env, workspace, query('inbox', { limit: 2 }));
    expect(first.messages.map(({ id }) => id)).toEqual(['email:incoming-1', 'inbox-z']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await loadMailboxPage(env, workspace, query('inbox', {
      limit: 2,
      cursor: {
        version: 1,
        folder: 'inbox',
        timestamp: first.messages.at(-1)!.sentAt,
        id: first.messages.at(-1)!.id
      }
    }));
    expect(second.messages.map(({ id }) => id)).toEqual(['inbox-a']);
    expect(second.hasMore).toBe(false);
  });

  test('applies server-side search and unread/starred filters', async () => {
    const { env, workspace } = fixture();
    const searched = await loadMailboxPage(env, workspace, query('inbox', { query: 'incident' }));
    expect(searched.messages.map(({ id }) => id)).toEqual(['inbox-z']);
    const unread = await loadMailboxPage(env, workspace, query('inbox', { filter: 'unread' }));
    expect(unread.messages.map(({ id }) => id)).toEqual(['email:incoming-1', 'inbox-z']);
    const starredDrafts = await loadMailboxPage(env, workspace, query('drafts', { filter: 'starred' }));
    expect(starredDrafts.messages.map(({ id }) => id)).toEqual(['draft-1']);
  });

  test('joins delivery state without per-message queries and returns global metrics', async () => {
    const { env, workspace } = fixture();
    const page = await loadMailboxPage(env, workspace, query('sent', { deliveryStatus: 'delivered' }));
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].deliveryStatus).toBe('delivered');
    expect(page.messages[0].deliveryLastEvent).toBe('email.delivered');
    expect(page.metrics).toEqual({
      inboxCount: 3,
      sentCount: 1,
      draftsCount: 1,
      unreadCount: 2,
      starredCount: 2
    });
  });
});
