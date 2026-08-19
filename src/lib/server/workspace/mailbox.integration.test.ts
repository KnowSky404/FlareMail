import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SQLQueryBindings } from 'bun:sqlite';
import { loadMailboxPage, loadWorkspaceSnapshot, mutateWorkspaceMailbox } from './mailbox';
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

  async run() {
    const result = this.database.query(this.sql).run(...this.bindings as SQLQueryBindings[]);
    return { meta: { changes: Number(result.changes) } };
  }
}

class TestD1 {
  queries: string[] = [];
  constructor(private readonly database: Database) {}
  prepare(sql: string) {
    this.queries.push(sql);
    return new TestStatement(this.database, sql) as unknown as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]) {
    for (const statement of statements) await (statement as unknown as TestStatement).run();
    return [];
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
    workspace,
    database
  };
}

const query = (folder: 'inbox' | 'sent' | 'drafts', overrides: Record<string, unknown> = {}) => ({
  folder,
  section: folder,
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

  test('loads only the active inbox page, selects no inbound body, and computes metrics once', async () => {
    const { env, workspace } = fixture();
    const db = env.DB as unknown as TestD1;
    const loaded = await loadWorkspaceSnapshot(env, workspace);

    expect(loaded.workspace.activeFolder).toBe('inbox');
    expect(Object.keys(loaded.pages)).toEqual(['inbox']);
    expect(loaded.workspace.mailbox.sent).toEqual([]);
    expect(loaded.workspace.mailbox.drafts).toEqual([]);
    expect(loaded.workspace.activePage.cursor).toBeNull();
    expect(loaded.workspace.activePage.status).toBeNull();
    expect(loaded.workspace.activePage.hasMore).toBe(false);
    expect(loaded.workspace.activePage.messages.find((message) => message.source === 'inbound')?.body).toBe('');
    expect(db.queries.filter((sql) => sql.includes('SELECT d.id'))).toHaveLength(0);
    expect(db.queries.filter((sql) => sql.includes('FROM workspace_messages AS m'))).toHaveLength(1);
    expect(db.queries.filter((sql) => sql.includes('SELECT COUNT(*)'))).toHaveLength(1);
    expect(db.queries.some((sql) => /\btext_body\b/u.test(sql))).toBe(false);
  });

  test('fresh-login snapshot exposes metrics and a usable next cursor for the active folder', async () => {
    const { env, workspace, database } = fixture();
    for (let index = 0; index < 45; index += 1) {
      database.query(`
        INSERT INTO workspace_messages (
          id, user_id, folder, from_name, from_email, to_name, to_email,
          subject, preview, body, sent_at, labels_json, is_read, is_starred
        ) VALUES (?, 'user-1', 'inbox', 'Bulk', 'bulk@example.test', 'Ada', 'ada@example.test',
          'Bulk subject', 'Bulk preview', 'Bulk body', ?, '[]', 1, 0)
      `).run(`bulk-${index}`, new Date(1_800_000_000_000 - index).toISOString());
    }

    const loaded = await loadWorkspaceSnapshot(env, workspace);
    const firstPage = loaded.workspace.activePage;
    expect(loaded.workspace.metrics.inboxCount).toBe(48);
    expect(firstPage.messages).toHaveLength(40);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).not.toBeNull();

    const nextPage = await loadMailboxPage(env, workspace, query('inbox', {
      cursor: {
        version: 1,
        folder: 'inbox',
        timestamp: firstPage.messages.at(-1)!.sentAt,
        id: firstPage.messages.at(-1)!.id
      }
    }));
    expect(nextPage.messages.length).toBeGreaterThan(0);
    expect(nextPage.metrics).toBeUndefined();
  });

  test('loads sent on demand without preloading inbox or drafts pages', async () => {
    const { env, workspace } = fixture();
    const db = env.DB as unknown as TestD1;
    const loaded = await loadWorkspaceSnapshot(env, workspace, { activeFolder: 'sent' });

    expect(loaded.workspace.activeFolder).toBe('sent');
    expect(Object.keys(loaded.pages)).toEqual(['sent']);
    expect(loaded.workspace.mailbox.inbox).toEqual([]);
    expect(loaded.workspace.mailbox.drafts).toEqual([]);
    expect(db.queries.filter((sql) => sql.includes('SELECT e.id AS email_id'))).toHaveLength(0);
    expect(db.queries.filter((sql) => sql.includes('SELECT d.id'))).toHaveLength(0);
    expect(db.queries.filter((sql) => sql.includes('FROM workspace_messages AS m'))).toHaveLength(1);
  });

  test('archives and restores mixed inbound/workspace selections atomically', async () => {
    const { env, workspace, database } = fixture();
    const result = await mutateWorkspaceMailbox(env, workspace, {
      action: 'archive',
      messageIds: ['inbox-z', 'email:incoming-1', 'inbox-z']
    });

    expect(result.summaries).toHaveLength(2);
    expect(result.movement.map((item) => item.id).sort()).toEqual(['email:incoming-1', 'inbox-z']);
    expect((database.query(`SELECT archived_at FROM workspace_messages WHERE id = 'inbox-z'`).get() as { archived_at: string | null }).archived_at).not.toBeNull();
    expect((database.query(`SELECT archived_at FROM workspace_email_states WHERE user_id = 'user-1' AND email_message_id = 'incoming-1'`).get() as { archived_at: string | null }).archived_at).not.toBeNull();

    const archivePage = await loadMailboxPage(env, workspace, query('inbox', { section: 'archive' }));
    expect(archivePage.folder).toBe('archive');
    expect(archivePage.messages.map(({ id }) => id).sort()).toEqual(['email:incoming-1', 'inbox-z']);

    await mutateWorkspaceMailbox(env, workspace, { action: 'unarchive', messageIds: ['inbox-z', 'email:incoming-1'] });
    const inboxPage = await loadMailboxPage(env, workspace, query('inbox'));
    expect(inboxPage.messages.map(({ id }) => id).sort()).toEqual(['email:incoming-1', 'inbox-a', 'inbox-z']);
  });

  test('rejects a partially owned selection before issuing a mutation', async () => {
    const { env, workspace, database } = fixture();
    await expect(mutateWorkspaceMailbox(env, workspace, {
      action: 'archive',
      messageIds: ['inbox-z', 'not-owned']
    })).rejects.toMatchObject({ code: 'MAILBOX_MESSAGE_NOT_FOUND' });
    expect((database.query(`SELECT archived_at FROM workspace_messages WHERE id = 'inbox-z'`).get() as { archived_at: string | null }).archived_at).toBeNull();
  });
});
