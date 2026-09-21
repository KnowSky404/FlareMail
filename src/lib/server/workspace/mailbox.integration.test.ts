import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SQLQueryBindings } from 'bun:sqlite';
import { loadMailboxPage, loadWorkspaceSnapshot, mutateWorkspaceMailbox } from './mailbox';
import { parseMailboxQuery } from './mailbox-query';
import type { WorkspaceContext } from './shared';
import { parseMailSearchQuery } from '$lib/domain/mail';

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
    this.database.exec('BEGIN');
    try {
      for (const statement of statements) await (statement as unknown as TestStatement).run();
      this.database.exec('COMMIT');
      return [];
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
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
  database.query(`UPDATE workspace_messages SET cc = 'Legacy Copy <legacy-copy@example.test>' WHERE id = 'sent-1'`).run();
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

const query = (folder: 'inbox' | 'sent' | 'drafts', overrides: Record<string, unknown> = {}) => {
  const result = {
    folder,
    section: folder,
    cursor: null,
    limit: 40,
    query: '',
    search: null as ReturnType<typeof parseMailSearchQuery> | null,
    filter: 'all' as const,
    deliveryStatus: null,
    ...overrides
  };
  result.search = result.query ? parseMailSearchQuery(result.query) : null;
  return result;
};

const mutationScope = (
  section: 'inbox' | 'sent' | 'archive' = 'inbox',
  identityFilter: { kind: 'domain' | 'address'; id: string } | null = null,
  threadScope: 'selected' | 'filtered' | 'owner' = 'selected',
  queryText = '',
  filter: 'all' | 'unread' | 'starred' = 'all'
) => ({
  section,
  identityFilter,
  threadScope,
  ...(threadScope === 'filtered' ? { query: queryText, filter } : {})
});

function insertCrossAddressThread(database: Database) {
  database.exec(`
    INSERT INTO mail_domains (id, owner_user_id, domain_name, cloudflare_zone_id, worker_name) VALUES
      ('domain-a', 'user-1', 'alpha.example', 'zone-a', 'flaremail'),
      ('domain-b', 'user-1', 'beta.example', 'zone-b', 'flaremail');
    INSERT INTO mail_addresses (id, owner_user_id, domain_id, email, local_part, receive_enabled, routing_state) VALUES
      ('address-a', 'user-1', 'domain-a', 'ada@alpha.example', 'ada', 1, 'active'),
      ('address-b', 'user-1', 'domain-b', 'ada@beta.example', 'ada', 1, 'active');
    UPDATE email_messages
    SET message_id = '<shared-rfc@example.test>', thread_key = 'shared-rfc',
      mail_domain_id = 'domain-a', mail_address_id = 'address-a'
    WHERE id = 'incoming-1';
    INSERT INTO email_messages (
      id, owner_user_id, "from", "to", subject, "timestamp", snippet, raw_key,
      text_body, direction, message_id, thread_key, mail_domain_id, mail_address_id
    ) VALUES ('incoming-b', 'user-1', 'Carol <carol@example.test>', 'ada@beta.example',
      'Inbound alert', '2026-08-13T13:00:00.000Z', 'incoming preview', 'raw/incoming-b',
      'incoming body', 'inbound', '<shared-rfc@example.test>', 'shared-rfc', 'domain-b', 'address-b');
    INSERT INTO workspace_messages (
      id, user_id, folder, from_name, from_email, to_name, to_email, subject, preview,
      body, sent_at, labels_json, is_read, is_starred, thread_key, recipient_address_id
    ) VALUES ('inbox-b', 'user-1', 'inbox', 'Carol', 'carol@example.test', 'Ada',
      'ada@beta.example', 'Inbound alert', 'incoming preview', 'body',
      '2026-08-13T13:00:00.000Z', '[]', 0, 0, 'shared-rfc', 'address-b');
    INSERT INTO email_messages (
      id, owner_user_id, "from", "to", subject, "timestamp", snippet, raw_key,
      text_body, direction, message_id, thread_key, mail_domain_id, mail_address_id
    ) VALUES ('incoming-a-read', 'user-1', 'Carol <carol@example.test>', 'ada@alpha.example',
      'Older shared reply', '2026-08-13T12:30:00.000Z', 'older preview', 'raw/incoming-a-read',
      'older body', 'inbound', '<shared-rfc@example.test>', 'shared-rfc', 'domain-a', 'address-a');
    INSERT INTO workspace_email_states (
      id, user_id, email_message_id, is_read, is_starred, created_at, updated_at
    ) VALUES ('state-incoming-a-read', 'user-1', 'incoming-a-read', 1, 0,
      '2026-08-13T12:30:00.000Z', '2026-08-13T12:30:00.000Z');
  `);
}

describe('D1 mailbox pages', () => {
  test('filters inbound, sent, drafts, search, metrics, options and cursors by owned domain and address', async () => {
    const { env, workspace, database } = fixture();
    database.exec(`
      INSERT INTO mail_domains (id, owner_user_id, domain_name, cloudflare_zone_id, worker_name) VALUES
        ('domain-a', 'user-1', 'alpha.example', 'zone-a', 'flaremail'),
        ('domain-b', 'user-1', 'beta.example', 'zone-b', 'flaremail');
      INSERT INTO mail_addresses (id, owner_user_id, domain_id, email, local_part, receive_enabled, routing_state) VALUES
        ('address-a1', 'user-1', 'domain-a', 'ada@alpha.example', 'ada', 1, 'active'),
        ('address-a2', 'user-1', 'domain-a', 'sales@alpha.example', 'sales', 1, 'active'),
        ('address-b1', 'user-1', 'domain-b', 'ada@beta.example', 'ada', 1, 'active');
      UPDATE workspace_messages SET recipient_address_id = 'address-a1' WHERE id = 'inbox-z';
      UPDATE workspace_messages SET recipient_address_id = 'address-a2' WHERE id = 'inbox-a';
      UPDATE workspace_messages SET sender_address_id = 'address-a2' WHERE id = 'sent-1';
      UPDATE workspace_drafts SET sender_address_id = 'address-b1' WHERE id = 'draft-1';
      UPDATE email_messages SET mail_domain_id = 'domain-b', mail_address_id = 'address-b1' WHERE id = 'incoming-1';
    `);

    const loaded = await loadWorkspaceSnapshot(env, workspace, {
      activeFolder: 'inbox', identityFilter: { kind: 'domain', id: 'domain-a' }
    });
    expect(loaded.workspace.mailIdentityOptions.domains.map((domain) => domain.domainName)).toEqual(['alpha.example', 'beta.example']);
    expect(loaded.workspace.mailIdentityOptions.addresses).toHaveLength(3);
    expect(loaded.workspace.mailboxPages.inbox?.messages.map(({ id }) => id).sort()).toEqual(['inbox-a', 'inbox-z']);
    expect(loaded.workspace.metrics).toMatchObject({ inboxCount: 2, archiveCount: 0, unreadCount: 1, starredCount: 1 });

    const sent = await loadMailboxPage(env, workspace, query('sent', { identityFilter: { kind: 'domain', id: 'domain-a' } }));
    expect(sent.messages.map(({ id }) => id)).toEqual(['sent-1']);
    expect(sent.metrics).toMatchObject({ sentCount: 1, inboxCount: 2, unreadCount: 1 });

    const drafts = await loadMailboxPage(env, workspace, query('drafts', { identityFilter: { kind: 'address', id: 'address-b1' } }));
    expect(drafts.messages.map(({ id }) => id)).toEqual(['draft-1']);
    expect(drafts.metrics).toMatchObject({ draftsCount: 1, inboxCount: 1, unreadCount: 1 });

    const searched = await loadMailboxPage(env, workspace, query('inbox', {
      query: 'subject:alert', identityFilter: { kind: 'address', id: 'address-b1' }
    }));
    expect(searched.messages.map(({ id }) => id)).toEqual(['email:incoming-1']);
    expect(searched.searchTotal).toBe(1);

    const first = await loadMailboxPage(env, workspace, query('inbox', {
      limit: 1, identityFilter: { kind: 'domain', id: 'domain-a' }
    }));
    expect(first.nextCursor).not.toBeNull();
    const nextQuery = parseMailboxQuery(new URLSearchParams({
      folder: 'inbox', identity: 'domain:domain-a', limit: '1', cursor: first.nextCursor!
    }));
    const second = await loadMailboxPage(env, workspace, nextQuery);
    expect(second.messages.map(({ id }) => id)).toHaveLength(1);
    expect(() => parseMailboxQuery(new URLSearchParams({
      folder: 'inbox', identity: 'address:address-a1', limit: '1', cursor: first.nextCursor!
    }))).toThrow();
  });

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
    const inboundSearch = await loadMailboxPage(env, workspace, query('inbox', { query: 'carol@example.test' }));
    expect(inboundSearch.messages.map(({ id }) => id)).toEqual(['email:incoming-1']);
    const legacyCcSearch = await loadMailboxPage(env, workspace, query('sent', { query: 'legacy-copy' }));
    expect(legacyCcSearch.messages.map(({ id }) => id)).toEqual(['sent-1']);
    const unread = await loadMailboxPage(env, workspace, query('inbox', { filter: 'unread' }));
    expect(unread.messages.map(({ id }) => id)).toEqual(['email:incoming-1', 'inbox-z']);
    const starredDrafts = await loadMailboxPage(env, workspace, query('drafts', { filter: 'starred' }));
    expect(starredDrafts.messages.map(({ id }) => id)).toEqual(['draft-1']);
  });

  test('executes advanced FTS filters with bounded snippets, totals and owner isolation', async () => {
    const { env, workspace, database } = fixture();
    database.query(`UPDATE workspace_messages SET labels_json = '["Operations"]', bcc_json = '[{"name":"Hidden","email":"secret@example.test"}]' WHERE id = 'inbox-z'`).run();
    database.query(`INSERT INTO workspace_attachments (id, user_id, message_id, filename, content_type, size, r2_key)
      VALUES ('attachment-z', 'user-1', 'inbox-z', 'incident.txt', 'text/plain', 12, 'fixtures/incident.txt')`).run();
    database.query(`INSERT INTO workspace_messages
      (id, user_id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at)
      VALUES ('foreign-incident', 'user-2', 'inbox', 'Zed', 'zed@example.test', 'Other', 'other@example.test', 'Alpha incident', 'private', 'private', '2026-08-13T14:00:00.000Z')`).run();

    const page = await loadMailboxPage(env, workspace, query('inbox', {
      query: 'from:zed@example.test subject:incident label:Operations is:unread has:attachment after:2026-08-12'
    }));
    expect(page.messages.map(({ id }) => id)).toEqual(['inbox-z']);
    expect(page.searchTotal).toBe(1);
    expect(page.searchHitFields).toEqual(['from', 'subject', 'label', 'state', 'attachment', 'date']);
    expect(page.messages[0]?.searchSnippet).toContain(String.fromCharCode(57344));
    expect(page.messages[0]?.searchHitFields).toEqual(page.searchHitFields);

    const bccSearch = await loadMailboxPage(env, workspace, query('inbox', { query: 'secret@example.test' }));
    expect(bccSearch.messages).toEqual([]);

    database.query(`UPDATE workspace_drafts SET subject = 'Updated roadmap', body = 'FTS trigger refresh' WHERE id = 'draft-1'`).run();
    const draftSearch = await loadMailboxPage(env, workspace, query('drafts', { query: 'subject:roadmap status:draft' }));
    expect(draftSearch.messages.map(({ id }) => id)).toEqual(['draft-1']);
  });

  test('combines FTS with delivery, archive and trash state filters', async () => {
    const { env, workspace } = fixture();
    const delivered = await loadMailboxPage(env, workspace, query('sent', { query: 'report status:delivered' }));
    expect(delivered.messages.map(({ id }) => id)).toEqual(['sent-1']);

    await mutateWorkspaceMailbox(env, workspace, { action: 'archive', messageIds: ['inbox-z'], scope: mutationScope() });
    const archived = await loadMailboxPage(env, workspace, query('inbox', { query: 'incident is:archived' }));
    expect(archived.messages.map(({ id }) => id)).toEqual(['inbox-z']);

    await mutateWorkspaceMailbox(env, workspace, { action: 'trash', messageIds: ['inbox-z'], scope: mutationScope('archive') });
    const trashed = await loadMailboxPage(env, workspace, query('inbox', { query: 'incident is:trash' }));
    expect(trashed.messages.map(({ id }) => id)).toEqual(['inbox-z']);
  });

  test('joins delivery state without per-message queries and returns global metrics', async () => {
    const { env, workspace, database } = fixture();
    database.exec(`
      INSERT INTO workspace_delivery_statuses (message_id, user_id, status, last_event_at) VALUES
        ('queued-global', 'user-1', 'queued', datetime('now')),
        ('submitting-fresh', 'user-1', 'submitting', datetime('now')),
        ('submitting-stale', 'user-1', 'submitting', datetime('now', '-20 minutes')),
        ('delayed-global', 'user-1', 'delayed', datetime('now')),
        ('failed-global', 'user-1', 'failed', datetime('now')),
        ('suppressed-global', 'user-1', 'suppressed', datetime('now')),
        ('bounced-global', 'user-1', 'bounced', datetime('now')),
        ('complained-global', 'user-1', 'complained', datetime('now')),
        ('foreign-failed', 'user-2', 'failed', datetime('now'))
    `);
    const page = await loadMailboxPage(env, workspace, query('sent', { deliveryStatus: 'delivered' }));
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].deliveryStatus).toBe('delivered');
    expect(page.messages[0].deliveryLastEvent).toBe('email.delivered');
    expect(page.metrics).toEqual({
      inboxCount: 3,
      archiveCount: 0,
      sentCount: 1,
      draftsCount: 1,
      trashCount: 0,
      unreadCount: 2,
      starredCount: 2,
      queuedCount: 3,
      delayedCount: 1,
      failedCount: 2,
      bouncedCount: 1,
      complainedCount: 1,
      staleDeliveryCount: 1
    });
  });

  test('loads only the active inbox page, selects no inbound body, and computes metrics once', async () => {
    const { env, workspace } = fixture();
    const db = env.DB as unknown as TestD1;
    const loaded = await loadWorkspaceSnapshot(env, workspace);

    expect(loaded.workspace.activeFolder).toBe('inbox');
    expect(Object.keys(loaded.workspace.mailboxPages)).toEqual(['inbox']);
    expect(loaded.workspace.mailbox.sent).toEqual([]);
    expect(loaded.workspace.mailbox.drafts).toEqual([]);
    expect(loaded.workspace.activePage.hasMore).toBe(false);
    expect(loaded.workspace.activePage.messages.find((message) => message.source === 'inbound')?.body).toBe('');
    expect(db.queries.filter((sql) => sql.includes('SELECT d.id'))).toHaveLength(0);
    expect(db.queries.filter((sql) => sql.includes('FROM workspace_messages AS m'))).toHaveLength(2);
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

  test('does not expose the legacy system sender in the workspace snapshot', async () => {
    const { env, workspace } = fixture();
    const loaded = await loadWorkspaceSnapshot({ ...env, OUTBOUND_FROM_EMAIL: 'mailer@example.test' }, workspace);
    expect(loaded.workspace.profile.email).toBe('ada@example.test');
    expect('outboundSenderEmail' in loaded.workspace).toBe(false);
  });

  test('loads sent on demand without preloading inbox or drafts pages', async () => {
    const { env, workspace } = fixture();
    const db = env.DB as unknown as TestD1;
    const loaded = await loadWorkspaceSnapshot(env, workspace, { activeFolder: 'sent' });

    expect(loaded.workspace.activeFolder).toBe('sent');
    expect(Object.keys(loaded.workspace.mailboxPages)).toEqual(['sent']);
    expect(loaded.workspace.mailbox.inbox).toEqual([]);
    expect(loaded.workspace.mailbox.drafts).toEqual([]);
    expect(db.queries.filter((sql) => sql.includes('SELECT e.id AS email_id'))).toHaveLength(0);
    expect(db.queries.filter((sql) => sql.includes('SELECT d.id'))).toHaveLength(0);
    expect(db.queries.filter((sql) => sql.includes('FROM workspace_messages AS m'))).toHaveLength(2);
  });

  test('archives and restores mixed inbound/workspace selections atomically', async () => {
    const { env, workspace, database } = fixture();
    const result = await mutateWorkspaceMailbox(env, workspace, {
      action: 'archive',
      messageIds: ['inbox-z', 'email:incoming-1', 'inbox-z'],
      scope: mutationScope()
    });

    expect(result.summaries).toHaveLength(2);
    expect(result.movement.map((item) => item.id).sort()).toEqual(['email:incoming-1', 'inbox-z']);
    expect((database.query(`SELECT archived_at FROM workspace_messages WHERE id = 'inbox-z'`).get() as { archived_at: string | null }).archived_at).not.toBeNull();
    expect((database.query(`SELECT archived_at FROM workspace_email_states WHERE user_id = 'user-1' AND email_message_id = 'incoming-1'`).get() as { archived_at: string | null }).archived_at).not.toBeNull();

    const archivePage = await loadMailboxPage(env, workspace, query('inbox', { section: 'archive' }));
    expect(archivePage.folder).toBe('archive');
    expect(archivePage.messages.map(({ id }) => id).sort()).toEqual(['email:incoming-1', 'inbox-z']);

    await mutateWorkspaceMailbox(env, workspace, { action: 'unarchive', messageIds: ['inbox-z', 'email:incoming-1'], scope: mutationScope('archive') });
    const inboxPage = await loadMailboxPage(env, workspace, query('inbox'));
    expect(inboxPage.messages.map(({ id }) => id).sort()).toEqual(['email:incoming-1', 'inbox-a', 'inbox-z']);
  });

  test('rejects a partially owned selection before issuing a mutation', async () => {
    const { env, workspace, database } = fixture();
    await expect(mutateWorkspaceMailbox(env, workspace, {
      action: 'archive',
      messageIds: ['inbox-z', 'not-owned'],
      scope: mutationScope()
    })).rejects.toMatchObject({ code: 'MAILBOX_MESSAGE_NOT_FOUND' });
    expect((database.query(`SELECT archived_at FROM workspace_messages WHERE id = 'inbox-z'`).get() as { archived_at: string | null }).archived_at).toBeNull();
  });

  test('moves an owned mixed selection to trash and updates global metrics', async () => {
    const { env, workspace, database } = fixture();
    const result = await mutateWorkspaceMailbox(env, workspace, {
      action: 'trash',
      messageIds: ['inbox-z', 'email:incoming-1'],
      scope: mutationScope()
    });

    expect((database.query(`SELECT deleted_at FROM workspace_messages WHERE id = 'inbox-z'`).get() as { deleted_at: string | null }).deleted_at).not.toBeNull();
    expect((database.query(`SELECT deleted_at FROM workspace_email_states WHERE user_id = 'user-1' AND email_message_id = 'incoming-1'`).get() as { deleted_at: string | null }).deleted_at).not.toBeNull();
    expect(result.metrics.trashCount).toBe(2);
    expect((await loadMailboxPage(env, workspace, query('inbox'))).messages.map(({ id }) => id)).not.toContain('inbox-z');
  });

  test.each([
    ['archive', { column: 'archived_at', expected: 'not-null' }],
    ['unarchive', { column: 'archived_at', expected: null }],
    ['read', { column: 'is_read', expected: 1 }],
    ['unread', { column: 'is_read', expected: 0 }],
    ['star', { column: 'is_starred', expected: 1 }],
    ['unstar', { column: 'is_starred', expected: 0 }]
  ] as const)('creates unique inbound state rows and applies %s idempotently', async (action, assertion) => {
    const { env, workspace, database } = fixture();
    const insert = database.query(`
      INSERT INTO email_messages (
        id, owner_user_id, "from", "to", subject, "timestamp", snippet, raw_key, text_body, direction
      ) VALUES (?, 'user-1', 'Bulk <bulk@example.test>', 'ada@example.test', ?, ?, 'preview', ?, 'body', 'inbound')
    `);
    const messageIds = ['fresh-1', 'fresh-2', 'fresh-3'];
    for (const [index, id] of messageIds.entries()) {
      insert.run(id, `Fresh ${index}`, `2026-08-13T14:0${index}:00.000Z`, `raw/${id}`);
    }
    const selected = messageIds.map((id) => `email:${id}`);

    await mutateWorkspaceMailbox(env, workspace, { action, messageIds: selected, scope: mutationScope() });
    await mutateWorkspaceMailbox(env, workspace, {
      action,
      messageIds: selected,
      scope: mutationScope(action === 'archive' ? 'archive' : 'inbox')
    });

    const rows = database.query(`
      SELECT id, email_message_id, is_read, is_starred, archived_at
      FROM workspace_email_states
      WHERE user_id = 'user-1' AND email_message_id IN ('fresh-1', 'fresh-2', 'fresh-3')
      ORDER BY email_message_id
    `).all() as Array<Record<string, string | number | null>>;
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    for (const row of rows) {
      if (assertion.expected === 'not-null') expect(row[assertion.column]).not.toBeNull();
      else expect(row[assertion.column]).toBe(assertion.expected);
    }
  });

  test('rejects mixed workspace and foreign inbound selections without partial writes', async () => {
    const { env, workspace, database } = fixture();
    database.query(`
      INSERT INTO email_messages (
        id, owner_user_id, "from", "to", subject, "timestamp", snippet, raw_key, direction
      ) VALUES ('foreign-1', 'user-2', 'Foreign <foreign@example.test>', 'other@example.test',
        'Foreign', '2026-08-13T14:00:00.000Z', 'foreign', 'raw/foreign-1', 'inbound')
    `).run();

    await expect(mutateWorkspaceMailbox(env, workspace, {
      action: 'archive',
      messageIds: ['inbox-z', 'email:incoming-1', 'email:foreign-1'],
      scope: mutationScope()
    })).rejects.toMatchObject({ code: 'MAILBOX_MESSAGE_NOT_FOUND' });

    expect((database.query(`SELECT archived_at FROM workspace_messages WHERE id = 'inbox-z'`).get() as { archived_at: string | null }).archived_at).toBeNull();
    expect(database.query(`SELECT COUNT(*) AS count FROM workspace_email_states WHERE user_id = 'user-1'`).get()).toEqual({ count: 0 });
  });

  test('rejects selections larger than the mutation limit before writing', async () => {
    const { env, workspace, database } = fixture();
    const ids = Array.from({ length: 101 }, (_, index) => `mail-${index}`);
    await expect(mutateWorkspaceMailbox(env, workspace, {
      action: 'read',
      messageIds: ids,
      scope: mutationScope()
    })).rejects.toMatchObject({ code: 'MAILBOX_SELECTION_TOO_LARGE' });
    expect(database.query(`SELECT COUNT(*) AS count FROM workspace_email_states`).get()).toEqual({ count: 0 });
  });

  test.each(['archive', 'read', 'star', 'trash'] as const)(
    'keeps address B unchanged when address A mutates a shared RFC thread (%s)',
    async (action) => {
      const { env, workspace, database } = fixture();
      insertCrossAddressThread(database);

      const result = await mutateWorkspaceMailbox(env, workspace, {
        action,
        messageIds: ['email:incoming-1'],
        threadKeys: ['shared-rfc'],
        scope: mutationScope('inbox', { kind: 'address', id: 'address-a' }, 'filtered', '', 'all')
      });

      expect(result.summaries.map((summary) => summary.id).sort()).toEqual(['email:incoming-1', 'email:incoming-a-read']);
      const bState = database.query(`
        SELECT is_read, is_starred, archived_at, deleted_at
        FROM workspace_email_states WHERE user_id = 'user-1' AND email_message_id = 'incoming-b'
      `).get();
      expect(bState).toBeNull();
      const workspaceB = database.query(`
        SELECT is_read, is_starred, archived_at, deleted_at FROM workspace_messages WHERE id = 'inbox-b'
      `).get() as { is_read: number; is_starred: number; archived_at: string | null; deleted_at: string | null };
      expect(workspaceB).toEqual({ is_read: 0, is_starred: 0, archived_at: null, deleted_at: null });
    }
  );

  test('selected-message scope does not expand to other messages in its thread', async () => {
    const { env, workspace, database } = fixture();
    insertCrossAddressThread(database);

    const result = await mutateWorkspaceMailbox(env, workspace, {
      action: 'star',
      messageIds: ['email:incoming-1'],
      scope: mutationScope('inbox', { kind: 'address', id: 'address-a' }, 'selected')
    });

    expect(result.summaries.map((summary) => summary.id)).toEqual(['email:incoming-1']);
    expect(database.query(`SELECT is_starred FROM workspace_email_states WHERE email_message_id = 'incoming-1'`).get()).toEqual({ is_starred: 1 });
    expect(database.query(`SELECT is_starred FROM workspace_email_states WHERE email_message_id = 'incoming-a-read'`).get()).toEqual({ is_starred: 0 });
    expect(database.query(`SELECT COUNT(*) AS count FROM workspace_email_states WHERE email_message_id = 'incoming-b'`).get()).toEqual({ count: 0 });
  });

  test('filtered thread actions change only messages matching the current unread filter', async () => {
    const { env, workspace, database } = fixture();
    insertCrossAddressThread(database);

    const result = await mutateWorkspaceMailbox(env, workspace, {
      action: 'star',
      messageIds: ['email:incoming-1'],
      threadKeys: ['shared-rfc'],
      scope: mutationScope('inbox', { kind: 'address', id: 'address-a' }, 'filtered', '', 'unread')
    });

    expect(result.summaries.map((summary) => summary.id)).toEqual(['email:incoming-1']);
    expect(database.query(`SELECT is_starred FROM workspace_email_states WHERE email_message_id = 'incoming-1'`).get()).toEqual({ is_starred: 1 });
    expect(database.query(`SELECT is_starred FROM workspace_email_states WHERE email_message_id = 'incoming-a-read'`).get()).toEqual({ is_starred: 0 });
    expect(database.query(`SELECT COUNT(*) AS count FROM workspace_email_states WHERE email_message_id = 'incoming-b'`).get()).toEqual({ count: 0 });
  });

  test('filtered thread actions apply the current server-side search query', async () => {
    const { env, workspace, database } = fixture();
    insertCrossAddressThread(database);

    const result = await mutateWorkspaceMailbox(env, workspace, {
      action: 'star',
      messageIds: ['email:incoming-1'],
      threadKeys: ['shared-rfc'],
      scope: mutationScope('inbox', { kind: 'address', id: 'address-a' }, 'filtered', 'subject:alert')
    });

    expect(result.summaries.map((summary) => summary.id)).toEqual(['email:incoming-1']);
    expect(database.query(`SELECT is_starred FROM workspace_email_states WHERE email_message_id = 'incoming-1'`).get()).toEqual({ is_starred: 1 });
    expect(database.query(`SELECT is_starred FROM workspace_email_states WHERE email_message_id = 'incoming-a-read'`).get()).toEqual({ is_starred: 0 });
    expect(database.query(`SELECT COUNT(*) AS count FROM workspace_email_states WHERE email_message_id = 'incoming-b'`).get()).toEqual({ count: 0 });
  });

  test('whole Owner thread expansion is explicit and crosses address filters', async () => {
    const { env, workspace, database } = fixture();
    insertCrossAddressThread(database);

    const result = await mutateWorkspaceMailbox(env, workspace, {
      action: 'read',
      messageIds: ['email:incoming-1'],
      threadKeys: ['shared-rfc'],
      scope: mutationScope('inbox', { kind: 'address', id: 'address-a' }, 'owner')
    });

    expect(result.summaries.map((summary) => summary.id).sort()).toEqual([
      'email:incoming-1', 'email:incoming-a-read', 'email:incoming-b', 'inbox-b'
    ]);
    expect(database.query(`SELECT is_read FROM workspace_email_states WHERE email_message_id = 'incoming-b'`).get()).toEqual({ is_read: 1 });
    expect(database.query(`SELECT is_read FROM workspace_messages WHERE id = 'inbox-b'`).get()).toEqual({ is_read: 1 });
    expect(result.metricsScope.identityFilter).toEqual({ kind: 'address', id: 'address-a' });
  });

  test('rejects out-of-scope IDs before writes', async () => {
    const { env, workspace, database } = fixture();
    insertCrossAddressThread(database);
    database.query(`
      INSERT INTO email_messages (id, owner_user_id, "from", "to", subject, "timestamp", snippet, raw_key, direction)
      VALUES ('foreign-inbox', 'user-2', 'Foreign <f@example.test>', 'f@beta.example', 'Foreign',
        '2026-08-13T14:00:00.000Z', 'foreign', 'raw/foreign-inbox', 'inbound')
    `).run();

    await expect(mutateWorkspaceMailbox(env, workspace, {
      action: 'read',
      messageIds: ['email:incoming-b'],
      scope: mutationScope('inbox', { kind: 'address', id: 'address-a' })
    })).rejects.toMatchObject({ code: 'MAILBOX_MESSAGE_NOT_FOUND' });
    await expect(mutateWorkspaceMailbox(env, workspace, {
      action: 'read',
      messageIds: ['email:foreign-inbox'],
      scope: mutationScope()
    })).rejects.toMatchObject({ code: 'MAILBOX_MESSAGE_NOT_FOUND' });
    await expect(mutateWorkspaceMailbox(env, workspace, {
      action: 'read',
      messageIds: ['sent-1'],
      scope: mutationScope('inbox')
    })).rejects.toMatchObject({ code: 'MAILBOX_MESSAGE_NOT_FOUND' });
    await expect(mutateWorkspaceMailbox(env, workspace, {
      action: 'read',
      messageIds: ['email:incoming-1'],
      scope: mutationScope('inbox', { kind: 'address', id: 'missing-address' })
    })).rejects.toMatchObject({ code: 'MAIL_IDENTITY_NOT_FOUND' });
    await expect(mutateWorkspaceMailbox(env, workspace, {
      action: 'read',
      messageIds: ['email:incoming-1'],
      scope: mutationScope('inbox', { kind: 'address', id: '../address-a' })
    })).rejects.toMatchObject({ code: 'INVALID_MAILBOX_SCOPE' });

    expect(database.query(`SELECT COUNT(*) AS count FROM workspace_email_states WHERE user_id = 'user-1'`).get()).toEqual({ count: 1 });
    expect(database.query(`SELECT is_read FROM workspace_messages WHERE id = 'inbox-b'`).get()).toEqual({ is_read: 0 });
  });

  test('rejects owner thread expansion above the cap before writes', async () => {
    const { env, workspace, database } = fixture();
    insertCrossAddressThread(database);
    const insert = database.query(`
      INSERT INTO email_messages (
        id, owner_user_id, "from", "to", subject, "timestamp", snippet, raw_key,
        text_body, direction, message_id, thread_key, mail_domain_id, mail_address_id
      ) VALUES (?, 'user-1', 'Carol <carol@example.test>', 'ada@beta.example', 'Overflow',
        '2026-08-13T12:00:00.000Z', 'overflow', ?, 'body', 'inbound',
        '<shared-rfc@example.test>', 'shared-rfc', 'domain-b', 'address-b')
    `);
    for (let index = 0; index < 98; index += 1) insert.run(`overflow-${index}`, `raw/overflow-${index}`);

    await expect(mutateWorkspaceMailbox(env, workspace, {
      action: 'read',
      messageIds: ['email:incoming-1'],
      threadKeys: ['shared-rfc'],
      scope: mutationScope('inbox', { kind: 'address', id: 'address-a' }, 'owner')
    })).rejects.toMatchObject({ code: 'MAILBOX_SELECTION_TOO_LARGE' });

    expect(database.query(`SELECT COUNT(*) AS count FROM workspace_email_states WHERE user_id = 'user-1'`).get()).toEqual({ count: 1 });
    expect(database.query(`SELECT is_read FROM workspace_messages WHERE id = 'inbox-b'`).get()).toEqual({ is_read: 0 });
  });
});
