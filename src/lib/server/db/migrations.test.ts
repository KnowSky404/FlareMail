import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '../../../..');
const migrationsDirectory = join(repositoryRoot, 'migrations');
const legacyFixture = join(repositoryRoot, 'tests/fixtures/legacy-schema.sql');
const latestSchema = join(repositoryRoot, 'schema.sql');

const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort();

function applyMigrations(db: Database) {
  // Wrangler records applied migrations and executes each file once. Keeping
  // that small bit of orchestration in the test catches accidental attempts
  // to make ALTER TABLE files replayable (SQLite has no ADD COLUMN IF NOT
  // EXISTS), while still exercising every statement in the real files.
  db.exec('CREATE TABLE IF NOT EXISTS _test_migrations (name TEXT PRIMARY KEY)');
  for (const file of migrationFiles) {
    const alreadyApplied = db
      .query('SELECT 1 AS applied FROM _test_migrations WHERE name = ?')
      .get(file) as { applied?: number } | null;
    if (alreadyApplied?.applied) continue;
    db.exec(readFileSync(join(migrationsDirectory, file), 'utf8'));
    db.query('INSERT INTO _test_migrations (name) VALUES (?)').run(file);
  }
}

function tableColumns(db: Database, table: string) {
  return new Set(
    (db.query(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as Array<{ name: string }>)
      .map((column) => column.name)
  );
}

function tableCount(db: Database, table: string) {
  const row = db.query(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number };
  return row.count;
}

function indexNames(db: Database, table: string) {
  return new Set(
    (db.query(`PRAGMA index_list("${table}")`).all() as Array<{ name: string }>)
      .map((index) => index.name)
      .filter((name) => !name.startsWith('sqlite_'))
  );
}

function createDatabase() {
  return new Database(':memory:');
}

describe('versioned D1 migrations', () => {
  test('keeps schema.sql aligned with the versioned migration result', () => {
    const migrated = createDatabase();
    const snapshot = createDatabase();
    applyMigrations(migrated);
    snapshot.exec(readFileSync(latestSchema, 'utf8'));

    const objects = (db: Database) => (db.query(`
      SELECT type, name FROM sqlite_master
      WHERE type IN ('table', 'index')
        AND name NOT LIKE 'sqlite_%'
        AND name <> '_test_migrations'
      ORDER BY type, name
    `).all());
    expect(objects(snapshot)).toEqual(objects(migrated));

    const tables = (objects(snapshot) as Array<{ type: string; name: string }>)
      .filter(({ type }) => type === 'table')
      .map(({ name }) => name);
    for (const table of tables) {
      const columns = (db: Database) => (db.query(`PRAGMA table_info("${table}")`).all() as Array<Record<string, unknown>>)
        .map(({ cid: _cid, ...column }) => column)
        .sort((left, right) => String(left.name).localeCompare(String(right.name)));
      expect(columns(snapshot)).toEqual(columns(migrated));
    }

    const indexes = (objects(snapshot) as Array<{ type: string; name: string }>)
      .filter(({ type }) => type === 'index')
      .map(({ name }) => name);
    for (const index of indexes) {
      const columns = (db: Database) => (db.query(`PRAGMA index_info("${index}")`).all() as Array<Record<string, unknown>>)
        .map(({ cid: _cid, ...column }) => column);
      expect(columns(snapshot)).toEqual(columns(migrated));
    }
  });

  test('builds the latest schema from an empty database', () => {
    const db = createDatabase();
    applyMigrations(db);

    expect(migrationFiles).toEqual([
      '0001_baseline.sql',
      '0002_mail_contracts.sql',
      '0003_auth_and_settings.sql',
      '0004_delivery_states.sql',
      '0005_operational_indexes.sql',
      '0006_inbound_ownership.sql'
    ]);

    expect(tableColumns(db, 'email_messages')).toEqual(
      new Set([
        'id', 'message_id', 'from', 'to', 'subject', 'timestamp', 'snippet', 'raw_key', 'raw_size', 'created_at',
        'in_reply_to', 'references', 'thread_key', 'direction', 'text_body', 'html_body', 'cc', 'dedupe_key',
        'provider_message_id', 'idempotency_key', 'owner_user_id'
      ])
    );
    expect(tableColumns(db, 'workspace_messages')).toEqual(
      new Set([
        'id', 'user_id', 'folder', 'from_name', 'from_email', 'to_name', 'to_email', 'subject', 'preview', 'body',
        'sent_at', 'labels_json', 'is_read', 'is_starred', 'created_at', 'updated_at', 'message_id', 'in_reply_to',
        'references', 'thread_key', 'direction', 'text_body', 'html_body', 'cc', 'dedupe_key', 'provider_message_id',
        'idempotency_key'
      ])
    );
    expect(tableColumns(db, 'workspace_users')).toEqual(
      new Set([
        'id', 'login_email', 'name', 'role', 'email', 'company', 'location', 'timezone', 'forwarding_enabled',
        'signature', 'incoming_sequence', 'created_at', 'updated_at', 'credential_hash', 'credential_salt',
        'credential_iterations', 'credential_updated_at'
      ])
    );
    expect(tableColumns(db, 'workspace_sessions')).toEqual(
      new Set(['id', 'user_id', 'created_at', 'updated_at', 'token_hash', 'expires_at', 'revoked_at', 'last_seen_at'])
    );
    expect(tableColumns(db, 'workspace_delivery_statuses')).toEqual(
      new Set([
        'message_id', 'user_id', 'status', 'attempts', 'idempotency_key', 'provider', 'provider_message_id',
        'last_error', 'submitted_at', 'sent_at', 'delivered_at', 'last_event', 'last_event_at', 'created_at',
        'updated_at'
      ])
    );
    expect(tableColumns(db, 'workspace_delivery_attempts')).toEqual(
      new Set([
        'id', 'message_id', 'user_id', 'attempt_number', 'idempotency_key', 'provider', 'provider_message_id',
        'status', 'error', 'started_at', 'completed_at', 'created_at'
      ])
    );
    expect(tableColumns(db, 'workspace_attachments')).toEqual(
      new Set([
        'id', 'user_id', 'message_id', 'filename', 'content_type', 'size', 'inline', 'content_id', 'r2_key', 'created_at'
      ])
    );
    expect(tableColumns(db, 'workspace_settings')).toEqual(
      new Set(['user_id', 'theme', 'settings_json', 'created_at', 'updated_at'])
    );

    expect(indexNames(db, 'email_messages')).toEqual(
      new Set([
        'idx_email_messages_timestamp', 'idx_email_messages_from', 'idx_email_messages_to',
        'idx_email_messages_message_id', 'idx_email_messages_thread_key', 'idx_email_messages_dedupe_key',
        'idx_email_messages_provider_message_id', 'idx_email_messages_recipient_cursor', 'idx_email_messages_owner_cursor'
      ])
    );
    expect(indexNames(db, 'workspace_delivery_statuses')).toEqual(
      new Set([
        'idx_workspace_delivery_statuses_idempotency_key',
        'idx_workspace_delivery_statuses_provider_message_id',
        'idx_workspace_delivery_statuses_user_status'
      ])
    );
    expect(indexNames(db, 'workspace_attachments')).toEqual(
      new Set(['idx_workspace_attachments_user_message', 'idx_workspace_attachments_content_id'])
    );

    // The complete state CHECK and idempotency/dedupe uniqueness are real D1
    // constraints, not just names documented in a migration.
    db.query(
      `INSERT INTO workspace_delivery_statuses (message_id, user_id, status, idempotency_key)
       VALUES ('m1', 'u1', 'submitted', 'idem-1')`
    ).run();
    expect(() => db.query(
      `INSERT INTO workspace_delivery_statuses (message_id, user_id, status, idempotency_key)
       VALUES ('m2', 'u1', 'not-a-state', 'idem-2')`
    ).run()).toThrow();
    expect(() => db.query(
      `INSERT INTO workspace_delivery_statuses (message_id, user_id, status, idempotency_key)
       VALUES ('m3', 'u1', 'queued', 'idem-1')`
    ).run()).toThrow();

    db.query(
      `INSERT INTO email_messages (id, "from", "to", "timestamp", raw_key, dedupe_key)
       VALUES ('e1', 'a@example.test', 'b@example.test', '2026-08-13T00:00:00Z', 'raw/e1', 'dedupe-1')`
    ).run();
    expect(() => db.query(
      `INSERT INTO email_messages (id, "from", "to", "timestamp", raw_key, dedupe_key)
       VALUES ('e2', 'a@example.test', 'b@example.test', '2026-08-13T00:00:00Z', 'raw/e2', 'dedupe-1')`
    ).run()).toThrow();
  });

  test('adds the schema to a legacy database without losing rows or values', () => {
    const db = createDatabase();
    db.exec(readFileSync(legacyFixture, 'utf8'));

    const before = Object.fromEntries([
      'email_messages', 'workspace_users', 'workspace_sessions', 'workspace_messages', 'workspace_drafts',
      'workspace_email_states', 'workspace_outbound_statuses', 'workspace_outbound_receipts', 'workspace_outbound_events'
    ].map((table) => [table, tableCount(db, table)]));

    applyMigrations(db);

    for (const [table, count] of Object.entries(before)) {
      expect(tableCount(db, table)).toBe(count);
    }

    const inbound = db.query(
      `SELECT message_id, thread_key, dedupe_key, direction, text_body, html_body, owner_user_id
       FROM email_messages WHERE id = 'legacy-email-1'`
    ).get() as Record<string, string | null>;
    expect(inbound).toMatchObject({
      message_id: '<legacy-1@example.test>',
      thread_key: 'rfc:<legacy-1@example.test>',
      dedupe_key: 'rfc:<legacy-1@example.test>:to:admin@example.test',
      direction: 'inbound',
      text_body: 'Legacy body',
      html_body: '',
      owner_user_id: 'legacy-user-1'
    });

    const workspaceInbound = db.query(
      `SELECT direction, text_body, thread_key, dedupe_key
       FROM workspace_messages WHERE id = 'legacy-message-1'`
    ).get() as Record<string, string>;
    expect(workspaceInbound).toMatchObject({
      direction: 'inbound', text_body: 'Legacy body', thread_key: 'legacy:legacy-message-1', dedupe_key: 'legacy:legacy-message-1'
    });

    const session = db.query(
      `SELECT token_hash, expires_at, last_seen_at FROM workspace_sessions WHERE id = 'legacy-session-1'`
    ).get() as Record<string, string | null>;
    expect(session.token_hash).toBeNull();
    expect(session.expires_at).toBe('2026-09-11 11:00:00');
    expect(session.last_seen_at).toBe('2026-08-12T11:00:00.000Z');
    expect(tableCount(db, 'workspace_settings')).toBe(1);
    expect(db.query(`SELECT theme FROM workspace_settings WHERE user_id = 'legacy-user-1'`).get()).toEqual({ theme: 'system' });

    const delivery = db.query(
      `SELECT status, attempts, provider, provider_message_id, last_event
       FROM workspace_delivery_statuses WHERE message_id = 'legacy-message-2'`
    ).get();
    expect(delivery).toEqual({ status: 'sent', attempts: 2, provider: 'legacy-provider', provider_message_id: 'provider-legacy-1', last_event: 'submission' });
    expect(tableCount(db, 'workspace_delivery_attempts')).toBe(1);

    // The runner skips files recorded as applied, so a second invocation is
    // idempotent and does not duplicate settings, statuses or attempt rows.
    const afterFirstRun = {
      settings: tableCount(db, 'workspace_settings'),
      delivery: tableCount(db, 'workspace_delivery_statuses'),
      attempts: tableCount(db, 'workspace_delivery_attempts')
    };
    applyMigrations(db);
    expect({
      settings: tableCount(db, 'workspace_settings'),
      delivery: tableCount(db, 'workspace_delivery_statuses'),
      attempts: tableCount(db, 'workspace_delivery_attempts')
    }).toEqual(afterFirstRun);
  });
});
