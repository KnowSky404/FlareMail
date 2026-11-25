import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hasReliableThreadContext } from '$lib/server/workspace/shared';

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

function applyMigrationsThrough(db: Database, lastFile: string) {
  db.exec('CREATE TABLE IF NOT EXISTS _test_migrations (name TEXT PRIMARY KEY)');
  for (const file of migrationFiles) {
    db.exec(readFileSync(join(migrationsDirectory, file), 'utf8'));
    db.query('INSERT INTO _test_migrations (name) VALUES (?)').run(file);
    if (file === lastFile) break;
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
  test('keeps migration 0029 identical to the reviewed bridge compatibility fixture', () => {
    expect(readFileSync(join(migrationsDirectory, '0029_blocked_senders.sql'), 'utf8'))
      .toBe(readFileSync(join(repositoryRoot, 'tests/fixtures/schema-29-bridge.sql'), 'utf8'));
  });

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

  test('backfills current historical issues without changing delivery facts or importing orphan and other-folder states', () => {
    const db = createDatabase();
    db.exec('PRAGMA foreign_keys = ON');
    applyMigrationsThrough(db, '0032_ai_automatic_classification.sql');
    db.exec(`
      INSERT INTO workspace_messages (id, user_id, folder, from_name, from_email, to_name, to_email, sent_at, deleted_at)
        VALUES ('old', 'owner', 'sent', '', 'sender@example.test', '', '', '2026-01-01', NULL),
          ('trashed', 'owner', 'sent', '', '', '', '', '2026-01-01', '2026-01-02'),
          ('received', 'owner', 'inbox', '', '', '', '', '2026-01-01', NULL);
      INSERT INTO workspace_delivery_statuses (message_id, user_id, status) VALUES
        ('old', 'owner', 'bounced'), ('trashed', 'owner', 'failed'),
        ('received', 'owner', 'complained'), ('orphan', 'owner', 'suppressed');
    `);
    applyMigrations(db);
    expect(db.query('SELECT message_id, kind, state FROM workspace_delivery_attention ORDER BY message_id').all()).toEqual([
      { message_id: 'old', kind: 'bounced', state: 'open' },
      { message_id: 'trashed', kind: 'failed', state: 'open' }
    ]);
    expect(db.query('SELECT status FROM workspace_delivery_statuses ORDER BY message_id').all()).toEqual([
      { status: 'bounced' }, { status: 'suppressed' }, { status: 'complained' }, { status: 'failed' }
    ]);
    const latest = createDatabase();
    latest.exec(readFileSync(latestSchema, 'utf8'));
    const attentionSql = (db: Database) => db.query(`
      SELECT sql FROM sqlite_master WHERE name LIKE 'workspace_delivery_attention%' ORDER BY name
    `).all() as { sql: string | null }[];
    const normalizedAttentionSql = (database: Database) => attentionSql(database)
      .map(({ sql }) => sql?.replace(/\s+/gu, ' ').replace(/\s*([(),])\s*/gu, '$1'));
    expect(normalizedAttentionSql(latest)).toEqual(normalizedAttentionSql(db));
    db.close();
    latest.close();
  });

  test('upgrades legacy sent mail with a same-attempt delay and preserves existing acknowledgements', () => {
    const db = createDatabase();
    applyMigrationsThrough(db, '0032_ai_automatic_classification.sql');
    db.exec(`
      INSERT INTO workspace_messages (id, user_id, folder, from_name, from_email, to_name, to_email, sent_at)
      SELECT value, 'owner', 'sent', '', 'sender@example.test', '', '', '2026-01-01'
      FROM json_each('["legacy", "earlier-attempt", "early-webhook", "ignored-delay", "existing", "delivered", "same-id-retry", "new-id-retry", "stalled-retry", "limited-retry", "unconfirmed-retry"]');
      INSERT INTO workspace_delivery_statuses (message_id, user_id, status, attempts, provider_message_id,
        submitted_at, last_event, last_event_at)
      SELECT id, user_id, CASE id WHEN 'delivered' THEN 'delivered' WHEN 'stalled-retry' THEN 'submitting' WHEN 'limited-retry' THEN 'delayed' ELSE 'sent' END,
        CASE WHEN id IN ('earlier-attempt', 'same-id-retry', 'new-id-retry', 'stalled-retry', 'limited-retry', 'unconfirmed-retry') THEN 2 ELSE 1 END, 'provider-' || id,
        '2026-01-01T00:00:00.000Z', CASE id WHEN 'delivered' THEN 'email.delivered' WHEN 'stalled-retry' THEN 'submission' WHEN 'limited-retry' THEN 'submission' ELSE 'email.sent' END,
        '2026-01-01T00:05:00.000Z' FROM workspace_messages;
      INSERT INTO workspace_outbound_events (svix_id, message_id, user_id, provider, provider_message_id, event_type, event_created_at)
      VALUES ('local:ignored-delay:submission:1', 'ignored-delay', 'owner', 'resend', 'provider-ignored-delay', 'submission', '2026-01-01T00:00:45.000Z');
      INSERT INTO workspace_outbound_events (svix_id, message_id, user_id, provider, provider_message_id, event_type, event_created_at)
      SELECT 'sent-' || id, id, user_id, 'resend', 'provider-' || id, 'email.sent', '2026-01-01T00:05:00.000Z'
      FROM workspace_messages WHERE id IN ('early-webhook', 'ignored-delay');
      INSERT INTO workspace_outbound_events (svix_id, message_id, user_id, provider, provider_message_id, event_type, event_created_at)
      SELECT id, id, user_id, 'resend', 'provider-' || id, 'email.delivery_delayed', '2026-01-01T00:01:00.000Z'
      FROM workspace_messages;
      INSERT INTO workspace_outbound_events (svix_id, message_id, user_id, provider, provider_message_id, event_type, event_created_at)
      VALUES ('local:early-webhook:submission:1', 'early-webhook', 'owner', 'resend', 'provider-early-webhook', 'submission', '2026-01-01T00:03:00.000Z');
      INSERT INTO workspace_delivery_attempts (id, message_id, user_id, attempt_number, provider_message_id, status, started_at, completed_at)
      VALUES ('attempt-2', 'earlier-attempt', 'owner', 2, 'provider-earlier-attempt', 'submitted',
        '2026-01-01T00:02:00.000Z', '2026-01-01T00:03:00.000Z'),
        ('in-flight', 'early-webhook', 'owner', 1, 'provider-early-webhook', 'submitted',
          '2026-01-01T00:00:30.000Z', '2026-01-01T00:03:00.000Z'),
        ('same-id-first', 'same-id-retry', 'owner', 1, 'provider-same-id-retry', 'submitted',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:30.000Z'),
        ('same-id-next', 'same-id-retry', 'owner', 2, 'provider-same-id-retry', 'submitted',
          '2026-01-01T00:02:00.000Z', '2026-01-01T00:03:00.000Z'),
        ('unconfirmed-first', 'unconfirmed-retry', 'owner', 1, NULL, 'submitting',
          '2026-01-01T00:00:00.000Z', NULL),
        ('unconfirmed-next', 'unconfirmed-retry', 'owner', 2, 'provider-unconfirmed-retry', 'submitted',
          '2026-01-01T00:02:00.000Z', '2026-01-01T00:03:00.000Z'),
        ('limited-first', 'limited-retry', 'owner', 1, 'provider-limited-retry', 'submitted',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:30.000Z'),
        ('limited-next', 'limited-retry', 'owner', 2, NULL, 'delayed',
          '2026-01-01T00:02:00.000Z', '2026-01-01T00:02:30.000Z'),
        ('stalled-first', 'stalled-retry', 'owner', 1, 'provider-stalled-retry', 'submitted',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:30.000Z'),
        ('stalled-next', 'stalled-retry', 'owner', 2, NULL, 'submitting',
          '2026-01-01T00:02:00.000Z', NULL),
        ('new-id-first', 'new-id-retry', 'owner', 1, 'provider-old', 'submitted',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:30.000Z'),
        ('new-id-next', 'new-id-retry', 'owner', 2, 'provider-new-id-retry', 'submitted',
          '2026-01-01T00:02:00.000Z', '2026-01-01T00:03:00.000Z'),
        ('already-accepted', 'ignored-delay', 'owner', 1, 'provider-ignored-delay', 'submitted',
          '2026-01-01T00:00:30.000Z', '2026-01-01T00:00:45.000Z');
      UPDATE workspace_outbound_events SET provider_message_id = 'provider-old' WHERE svix_id='new-id-retry';
    `);
    db.exec(readFileSync(join(migrationsDirectory, '0033_delivery_attention.sql'), 'utf8'));
    db.query('INSERT INTO _test_migrations (name) VALUES (?)').run('0033_delivery_attention.sql');
    db.exec(`
      INSERT INTO workspace_delivery_attention (user_id, message_id, attempt_number, kind, eligible_at, state)
      VALUES ('owner', 'existing', 1, 'delayed', '2026-01-01T00:01:00.000Z', 'acknowledged');
    `);
    applyMigrations(db);
    expect(db.query('SELECT message_id, kind, eligible_at, state FROM workspace_delivery_attention ORDER BY message_id').all()).toEqual([
      { message_id: 'early-webhook', kind: 'delayed', eligible_at: '2026-01-01T00:01:00.000Z', state: 'open' },
      { message_id: 'existing', kind: 'delayed', eligible_at: '2026-01-01T00:01:00.000Z', state: 'acknowledged' },
      { message_id: 'legacy', kind: 'delayed', eligible_at: '2026-01-01T00:01:00.000Z', state: 'open' },
      { message_id: 'limited-retry', kind: 'delayed', eligible_at: '2026-01-01T00:05:00.000Z', state: 'open' },
      { message_id: 'limited-retry', kind: 'delayed', eligible_at: '2026-01-01T00:01:00.000Z', state: 'open' },
      { message_id: 'same-id-retry', kind: 'delayed', eligible_at: '2026-01-01T00:01:00.000Z', state: 'open' },
      { message_id: 'stalled-retry', kind: 'stale_submitting', eligible_at: '2026-01-01T00:20:00.000Z', state: 'open' },
      { message_id: 'stalled-retry', kind: 'delayed', eligible_at: '2026-01-01T00:01:00.000Z', state: 'open' },
      { message_id: 'unconfirmed-retry', kind: 'delayed', eligible_at: '2026-01-01T00:01:00.000Z', state: 'open' }
    ]);
    db.exec(`
      UPDATE workspace_delivery_statuses
      SET status = 'submitting', attempts = 3, last_event_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE message_id IN ('stalled-retry', 'limited-retry');
      UPDATE workspace_delivery_statuses SET status = 'submitted' WHERE message_id IN ('stalled-retry', 'limited-retry');
    `);
    expect(db.query("SELECT kind, state FROM workspace_delivery_attention WHERE message_id = 'stalled-retry' ORDER BY id").all())
      .toEqual([{ kind: 'stale_submitting', state: 'resolved' }, { kind: 'delayed', state: 'open' }]);
    expect(db.query("SELECT delayed_provider_message_id, state FROM workspace_delivery_attention WHERE message_id = 'limited-retry' ORDER BY id").all())
      .toEqual([{ delayed_provider_message_id: null, state: 'resolved' },
        { delayed_provider_message_id: 'provider-limited-retry', state: 'open' }]);
    db.close();
  });

  test('recovers in-flight same-ID delays before and after a same-ID sent event without reopening known outcomes', () => {
    const db = createDatabase();
    applyMigrationsThrough(db, '0032_ai_automatic_classification.sql');
    db.exec(`
      INSERT INTO workspace_messages (id, user_id, folder, from_name, from_email, to_name, to_email, sent_at)
      SELECT value, 'owner', 'sent', '', 'sender@example.test', '', '', '2026-01-01'
      FROM json_each('["in-flight", "in-flight-sent", "replaced", "terminal", "sent-terminal", "acknowledged"]');
      INSERT INTO workspace_delivery_statuses (message_id, user_id, status, attempts, provider_message_id, last_event, last_event_at)
      SELECT id, user_id, CASE WHEN id IN ('in-flight-sent', 'sent-terminal') THEN 'sent' ELSE 'submitted' END,
        2, 'current-' || id, CASE WHEN id IN ('in-flight-sent', 'sent-terminal') THEN 'email.sent' ELSE 'submission' END,
        '2026-01-01T00:03:00.000Z'
      FROM workspace_messages;
      INSERT INTO workspace_delivery_attempts (id, message_id, user_id, attempt_number, provider_message_id, status, started_at, completed_at)
      SELECT id || '-first', id, user_id, 1, CASE id WHEN 'replaced' THEN 'different-id' ELSE 'current-' || id END,
        'submitted', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z' FROM workspace_messages
      UNION ALL SELECT id || '-retry', id, user_id, 2, 'current-' || id, 'submitted',
        '2026-01-01T00:02:00.000Z', '2026-01-01T00:03:00.000Z' FROM workspace_messages;
      INSERT INTO workspace_outbound_events (svix_id, message_id, user_id, provider, provider_message_id, event_type, event_created_at)
      SELECT id || '-delayed', id, user_id, 'resend', 'current-' || id, 'email.delivery_delayed', '2026-01-01T00:02:30.000Z'
      FROM workspace_messages;
      INSERT INTO workspace_outbound_events (svix_id, message_id, user_id, provider, provider_message_id, event_type, event_created_at)
      VALUES ('terminal-delivered', 'terminal', 'owner', 'resend', 'current-terminal', 'email.delivered', '2026-01-01T00:02:40.000Z'),
        ('sent-terminal-delivered', 'sent-terminal', 'owner', 'resend', 'current-sent-terminal', 'email.delivered', '2026-01-01T00:02:40.000Z');
      INSERT INTO workspace_outbound_events (svix_id, message_id, user_id, provider, provider_message_id, event_type, event_created_at)
      SELECT 'local:' || id || ':submission:2', id, user_id, 'resend', 'current-' || id, 'submission', '2026-01-01T00:03:00.000Z'
      FROM workspace_messages;
      INSERT INTO workspace_outbound_events (svix_id, message_id, user_id, provider, provider_message_id, event_type, event_created_at)
      SELECT id || '-sent', id, user_id, 'resend', 'current-' || id, 'email.sent', '2026-01-01T00:03:30.000Z'
      FROM workspace_messages WHERE id IN ('in-flight-sent', 'sent-terminal');
    `);
    for (const file of ['0033_delivery_attention.sql', '0034_delivery_attention_backfill.sql', '0035_preserve_replayed_delivery_delay.sql']) {
      db.exec(readFileSync(join(migrationsDirectory, file), 'utf8'));
      db.query('INSERT INTO _test_migrations (name) VALUES (?)').run(file);
    }
    expect(db.query('SELECT id FROM workspace_delivery_attention').all()).toEqual([]);
    db.exec(`
      INSERT INTO workspace_delivery_attention (user_id, message_id, attempt_number, kind, eligible_at, state, delayed_provider_message_id)
      VALUES ('owner', 'acknowledged', 2, 'delayed', '2026-01-01T00:02:30.000Z', 'acknowledged', 'current-acknowledged');
    `);
    applyMigrations(db);
    expect(db.query('SELECT message_id, state FROM workspace_delivery_attention ORDER BY message_id').all()).toEqual([
      { message_id: 'acknowledged', state: 'acknowledged' },
      { message_id: 'in-flight', state: 'open' },
      { message_id: 'in-flight-sent', state: 'open' }
    ]);
    db.close();
  });

  test('queues legacy unmatched webhooks only for exact known Resend IDs', () => {
    const db = createDatabase();
    applyMigrationsThrough(db, '0037_recover_sent_resend_delays.sql');
    db.exec(`
      INSERT INTO workspace_delivery_statuses (message_id, user_id, status, attempts, provider_message_id)
      VALUES ('known', 'owner', 'submitted', 1, 're_known');
      INSERT INTO workspace_outbound_events
        (svix_id, message_id, user_id, provider, provider_message_id, event_type, event_created_at, payload_json)
      VALUES ('matched', 're_known', 'unmatched', 'resend', 're_known', 'email.bounced', '2026-01-01',
        '{"type":"email.bounced","data":{"email_id":"re_known"}}'),
        ('unknown', 're_unknown', 'unmatched', 'resend', 're_unknown', 'email.sent', '2026-01-01',
        '{"type":"email.sent","data":{"email_id":"re_unknown"}}'),
        ('other-provider', 're_known', 'unmatched', 'fake', 're_known', 'email.sent', '2026-01-01',
        '{"type":"email.sent","data":{"email_id":"re_known"}}'),
        ('invalid-json', 're_known', 'unmatched', 'resend', 're_known', 'email.sent', '2026-01-01', 'invalid');
    `);
    applyMigrations(db);
    expect(db.query(`
      SELECT svix_id, message_id, user_id, CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$._flaremailDeferred') END AS deferred
      FROM workspace_outbound_events ORDER BY svix_id
    `).all()).toEqual([
      { svix_id: 'invalid-json', message_id: 're_known', user_id: 'unmatched', deferred: null },
      { svix_id: 'matched', message_id: 'known', user_id: 'owner', deferred: 1 },
      { svix_id: 'other-provider', message_id: 're_known', user_id: 'unmatched', deferred: null },
      { svix_id: 'unknown', message_id: 're_unknown', user_id: 'unmatched', deferred: null }
    ]);
    expect(db.query('SELECT status FROM workspace_delivery_statuses').get()).toEqual({ status: 'submitted' });
    db.close();
  });

  test('corrects an existing submission timeout without losing millisecond precision', () => {
    const db = createDatabase();
    applyMigrationsThrough(db, '0039_queue_legacy_resend_failures.sql');
    db.exec(`
      INSERT INTO workspace_messages (id, user_id, folder, from_name, from_email, to_name, to_email, sent_at)
      VALUES ('submitting', 'owner', 'sent', '', 'sender@example.test', '', '', '2026-01-01'),
        ('already-stale', 'owner', 'sent', '', 'sender@example.test', '', '', '2026-01-01');
      INSERT INTO workspace_delivery_statuses (message_id, user_id, status, attempts, last_event_at)
      VALUES ('submitting', 'owner', 'submitting', 1, '2026-01-01T12:00:00.900Z'),
        ('already-stale', 'owner', 'submitting', 1, '2026-01-01T12:00:01.900Z');
      UPDATE workspace_delivery_statuses SET last_event_at = '2026-01-01T12:30:00.900Z'
      WHERE message_id = 'already-stale';
    `);
    const eligible = db.query('SELECT eligible_at FROM workspace_delivery_attention WHERE message_id = ?');
    expect(eligible.get('submitting')).toEqual({ eligible_at: '2026-01-01T12:15:00.000Z' });

    applyMigrations(db);

    expect(eligible.get('submitting')).toEqual({ eligible_at: '2026-01-01T12:15:00.900Z' });
    expect(eligible.get('already-stale')).toEqual({ eligible_at: '2026-01-01T12:15:01.000Z' });
    db.close();
  });

  test.each([
    ['before timeout', 'submitting', false, 'bounced', 65],
    ['after timeout', 'submitting', true, 'failed', 68],
    ['after local failure', 'failed', true, 'failed', 50],
    ['older failure after local failure', 'failed', true, 'bounced', 65],
    ['newer failure after local failure', 'failed', true, 'failed', 85]
  ] as const)('recovers a terminal outcome across an unconfirmed same-ID retry (%s)', (label, localStatus, afterReset, status, statusTime) => {
    const db = createDatabase();
    applyMigrationsThrough(db, '0039_queue_legacy_resend_failures.sql');
    const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1_000).toISOString();
    db.exec(`
      INSERT INTO workspace_messages (id, user_id, folder, from_name, from_email, to_name, to_email, sent_at)
      VALUES ('retry-gap', 'owner', 'sent', '', 'sender@example.test', '', '', '${at(0)}');
      INSERT INTO workspace_delivery_statuses
        (message_id, user_id, status, attempts, provider, provider_message_id, last_event, last_event_at)
      VALUES ('retry-gap', 'owner', 'submitted', 3, 'resend', 're_1', 'submission', '${at(180)}');
      INSERT INTO workspace_outbound_receipts
        (message_id, user_id, provider, result_kind, remote_status, last_event, last_event_at)
      VALUES ('retry-gap', 'owner', 'resend', 'accepted', 202, 'submission', '${at(180)}');
      INSERT INTO workspace_delivery_attempts
        (id, message_id, user_id, attempt_number, provider, provider_message_id, status, started_at)
      VALUES ('initial', 'retry-gap', 'owner', 1, 'resend', 're_1', 'submitted', '${at(0)}'),
        ('timed-out', 'retry-gap', 'owner', 2, 'resend', NULL, '${localStatus}', '${at(60)}'),
        ('latest', 'retry-gap', 'owner', 3, 'resend', 're_1', 'submitted', '${at(120)}');
    `);
    const event = db.query(`INSERT INTO workspace_outbound_events
      (svix_id, message_id, user_id, provider, provider_message_id, event_type, event_created_at, payload_json, created_at)
      VALUES (?, 'retry-gap', 'owner', 'resend', ?, ?, ?, ?, ?)`);
    event.run('local:retry-gap:submission:1', 're_1', 'submission', at(30), '{"status":"submitted"}', at(30));
    const legacyFailed = label === 'after local failure';
    const firstKind = legacyFailed ? 'email.failed' : 'email.bounced';
    const firstTime = legacyFailed ? 50 : 65;
    event.run('first-outcome', 're_1', firstKind, at(firstTime),
      JSON.stringify({ type: firstKind, created_at: at(firstTime), data: { email_id: 're_1' } }), at(legacyFailed ? 55 : 70));
    const reset = () => event.run('local:retry-gap:submission:2', null, 'submission', at(80),
      JSON.stringify({ status: localStatus }), at(80));
    if (afterReset) reset();
    const laterKind = legacyFailed ? 'email.bounced' : 'email.failed';
    const laterTime = label === 'newer failure after local failure' ? 85 : 68;
    event.run('later-outcome', 're_1', laterKind, at(laterTime),
      JSON.stringify({ type: laterKind, created_at: at(laterTime), data: { email_id: 're_1' } }), at(afterReset ? 90 : 75));
    if (!afterReset) reset();
    event.run('local:retry-gap:submission:3', 're_1', 'submission', at(180), '{"status":"submitted"}', at(180));

    const prior = '0040_recover_masked_resend_terminal_events.sql';
    db.exec(readFileSync(join(migrationsDirectory, prior), 'utf8'));
    db.query('INSERT INTO _test_migrations (name) VALUES (?)').run(prior);
    expect(db.query('SELECT status FROM workspace_delivery_statuses').get()).toEqual({ status: 'submitted' });

    applyMigrations(db);

    expect(db.query('SELECT status, last_event_at FROM workspace_delivery_statuses').get()).toEqual({
      status, last_event_at: at(statusTime)
    });
    expect(db.query('SELECT last_event, result_kind, remote_status FROM workspace_outbound_receipts').get()).toEqual({
      last_event: 'email.' + status, result_kind: 'permanent_failure', remote_status: 202
    });
    expect(db.query('SELECT kind, state, attempt_number FROM workspace_delivery_attention').all()).toEqual([
      { kind: status, state: 'open', attempt_number: 3 }
    ]);
    expect(db.query('SELECT COUNT(*) AS count FROM workspace_outbound_events').get()).toEqual({ count: 5 });
    db.close();
  });

  test.each([
    ['email.bounced', null, 'submitted', false, null],
    ['email.bounced', 'email.sent', 'sent', false, null],
    ['email.bounced', 'email.sent', 'sent', true, null],
    ['email.delivered', 'email.delivery_delayed', 'delayed', false, null],
    ['email.bounced', 'email.sent', 'sent', false, 'received'],
    ['email.bounced', null, 'submitted', false, 'received'],
    ['email.bounced', 'email.sent', 'sent', false, 'replayed'],
    ['email.bounced', 'email.sent', 'sent', false, 'unmatched'],
    ['email.bounced', 'email.sent', 'sent', false, 'ambiguous']
  ] as const)('corrects an ignored legacy %s with later progress %s (%s, acknowledged %s, earlier delay %s)', (ignored, progress, expected, acknowledged, earlierDelay) => {
    const db = createDatabase();
    applyMigrationsThrough(db, '0032_ai_automatic_classification.sql');
    const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1_000).toISOString();
    db.exec(`
      INSERT INTO workspace_messages (id, user_id, folder, from_name, from_email, to_name, to_email, sent_at)
      VALUES ('ignored-terminal', 'owner', 'sent', '', 'sender@example.test', '', '', '${at(0)}');
      INSERT INTO workspace_delivery_statuses
        (message_id, user_id, status, attempts, provider, provider_message_id, last_event, last_event_at)
      VALUES ('ignored-terminal', 'owner', '${expected}', 3, 'resend', 're_1', '${progress ?? 'submission'}', '${at(progress ? 190 : 180)}');
      INSERT INTO workspace_outbound_receipts
        (message_id, user_id, provider, result_kind, remote_status, last_event, last_event_at)
      VALUES ('ignored-terminal', 'owner', 'resend', 'accepted', 202, 'submission', '${at(180)}');
      INSERT INTO workspace_delivery_attempts
        (id, message_id, user_id, attempt_number, provider, provider_message_id, status, started_at)
      VALUES ('initial', 'ignored-terminal', 'owner', 1, 'resend', 're_1', 'submitted', '${at(0)}'),
        ('failed-locally', 'ignored-terminal', 'owner', 2, 'resend', NULL, 'failed', '${at(60)}'),
        ('latest', 'ignored-terminal', 'owner', 3, 'resend', 're_1', 'submitted', '${at(120)}');
    `);
    const event = db.query(`INSERT INTO workspace_outbound_events
      (svix_id, message_id, user_id, provider, provider_message_id, event_type, event_created_at, payload_json, created_at)
      VALUES (?, 'ignored-terminal', 'owner', 'resend', ?, ?, ?, ?, ?)`);
    const providerEvent = (kind: string, seconds: number) =>
      JSON.stringify({ type: kind, created_at: at(seconds), data: { email_id: 're_1' } });
    if (earlierDelay && earlierDelay !== 'received') {
      event.run('earlier-delay', 're_1', 'email.delivery_delayed', at(20), providerEvent('email.delivery_delayed', 20), at(20));
      if (earlierDelay === 'unmatched') {
        db.exec("UPDATE workspace_outbound_events SET message_id = 're_1', user_id = 'unmatched' WHERE svix_id = 'earlier-delay'");
      }
    }
    event.run('local:ignored-terminal:submission:1', 're_1', 'submission', at(30), '{"status":"submitted"}', at(30));
    if (earlierDelay === 'received') {
      event.run('earlier-delay', 're_1', 'email.delivery_delayed', at(50), providerEvent('email.delivery_delayed', 50), at(50));
    }
    if (earlierDelay === 'ambiguous') {
      event.run('earlier-sent', 're_1', 'email.sent', at(50), providerEvent('email.sent', 50), at(50));
    }
    event.run('local:ignored-terminal:submission:2', null, 'submission', at(80), '{"status":"failed"}', at(80));
    event.run('ignored-event', 're_1', ignored, at(90), providerEvent(ignored, 90), at(90));
    event.run('local:ignored-terminal:submission:3', 're_1', 'submission', at(180), '{"status":"submitted"}', at(180));
    if (expected === 'sent' && !earlierDelay) {
      event.run('verified-delay', 're_1', 'email.delivery_delayed', at(185), providerEvent('email.delivery_delayed', 185), at(185));
    }
    if (progress) event.run('later-progress', 're_1', progress, at(190), providerEvent(progress, 190), at(190));

    const prior = '0040_recover_masked_resend_terminal_events.sql';
    for (const migration of migrationFiles.slice(32, migrationFiles.indexOf(prior))) {
      db.exec(readFileSync(join(migrationsDirectory, migration), 'utf8'));
      db.query('INSERT INTO _test_migrations (name) VALUES (?)').run(migration);
    }
    const pending = db.query('SELECT kind, state, eligible_at FROM workspace_delivery_attention WHERE closed_at IS NULL');
    const eligibility = at(earlierDelay === 'replayed' ? 20 : earlierDelay === 'received' ? 50 : expected === 'sent' ? 185 : 190);
    expect(pending.all()).toEqual(expected === 'submitted' || earlierDelay ? [] : [{ kind: 'delayed', state: 'open', eligible_at: eligibility }]);
    if (acknowledged) {
      db.query("UPDATE workspace_delivery_attention SET state = 'acknowledged', acknowledged_at = ? WHERE kind = 'delayed'").run(at(195));
    }
    db.exec(readFileSync(join(migrationsDirectory, prior), 'utf8'));
    db.query('INSERT INTO _test_migrations (name) VALUES (?)').run(prior);
    expect(db.query('SELECT status FROM workspace_delivery_statuses').get()).toEqual({ status: ignored.slice(6) });
    const snapshot = db.query<{ version: number }, []>('SELECT version FROM workspace_delivery_attention_clock').get()!;

    applyMigrations(db);

    expect(db.query('SELECT status, last_event, delivered_at FROM workspace_delivery_statuses').get()).toEqual({
      status: expected, last_event: progress ?? 'submission', delivered_at: null
    });
    expect(db.query('SELECT last_event, result_kind, remote_status FROM workspace_outbound_receipts').get()).toEqual({
      last_event: progress ?? 'submission', result_kind: expected === 'delayed' ? 'temporary_failure' : 'accepted', remote_status: 202
    });
    const hasDelay = earlierDelay ? earlierDelay === 'received' || earlierDelay === 'replayed' : expected !== 'submitted';
    expect(pending.all()).toEqual(!hasDelay ? [] : [
      { kind: 'delayed', state: acknowledged ? 'acknowledged' : 'open', eligible_at: eligibility }
    ]);
    const lateItems = db.query<{ version: number }, []>("SELECT version FROM workspace_delivery_attention WHERE kind = 'delayed' AND closed_at IS NULL").all();
    for (const { version } of lateItems) expect(version).toBeGreaterThan(snapshot.version);
    expect(db.query("SELECT event_type FROM workspace_outbound_events WHERE svix_id = 'ignored-event'").get())
      .toEqual({ event_type: ignored });
    db.close();
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
      '0006_inbound_ownership.sql',
      '0007_outbound_contracts.sql',
      '0008_login_rate_limits.sql',
      '0009_inbound_ingest_claims.sql',
      '0010_mailbox_archive_and_bulk.sql',
      '0011_recipient_arrays.sql',
      '0012_body_objects.sql',
      '0013_trash.sql',
      '0014_inbound_metadata.sql',
      '0015_search_fts.sql',
      '0016_outbound_attachments.sql',
      '0017_r2_cleanup_queue_reliability.sql',
      '0018_outbound_rate_limits.sql',
      '0019_telegram_notifications.sql',
      '0020_telegram_user_delete_cleanup.sql',
      '0021_telegram_challenge_provenance.sql',
      '0022_telegram_delivery_privacy_snapshot.sql',
      '0023_owner_principal_auth.sql',
      '0024_managed_mail_identities.sql',
      '0025_mail_domain_health_refresh.sql',
      '0026_mail_address_delete_policy.sql',
      '0027_persistent_mail_labels.sql',
      '0028_inbox_categories.sql',
      '0029_blocked_senders.sql',
      '0030_mail_ai_analyses.sql',
      '0031_telegram_ai_summary.sql',
      '0032_ai_automatic_classification.sql',
      '0033_delivery_attention.sql',
      '0034_delivery_attention_backfill.sql',
      '0035_preserve_replayed_delivery_delay.sql',
      '0036_recover_pending_resend_events.sql',
      '0037_recover_sent_resend_delays.sql',
      '0038_queue_legacy_resend_events.sql',
      '0039_queue_legacy_resend_failures.sql',
      '0040_recover_masked_resend_terminal_events.sql',
      '0041_recover_terminal_outcomes_across_retries.sql'
    ]);

    expect(tableColumns(db, 'email_messages')).toEqual(
      new Set([
        'id', 'message_id', 'from', 'to', 'subject', 'timestamp', 'snippet', 'raw_key', 'raw_size', 'created_at',
        'in_reply_to', 'references', 'thread_key', 'direction', 'text_body', 'html_body', 'cc', 'dedupe_key',
        'provider_message_id', 'idempotency_key', 'owner_user_id', 'body_object_id', 'to_json', 'cc_json',
        'reply_to_json', 'return_path', 'delivered_to', 'headers_json', 'authentication_results_json',
        'mail_domain_id', 'mail_address_id', 'recipient_status', 'inbox_category', 'inbox_category_v2', 'ai_inbox_category'
      ])
    );
    expect(tableColumns(db, 'workspace_messages')).toEqual(
      new Set([
        'id', 'user_id', 'folder', 'from_name', 'from_email', 'to_name', 'to_email', 'subject', 'preview', 'body',
        'sent_at', 'labels_json', 'is_read', 'is_starred', 'created_at', 'updated_at', 'message_id', 'in_reply_to',
        'references', 'thread_key', 'direction', 'text_body', 'html_body', 'cc', 'to_json', 'cc_json', 'bcc_json', 'dedupe_key', 'provider_message_id',
        'idempotency_key', 'archived_at', 'deleted_at', 'body_object_id', 'sender_address_id',
        'recipient_address_id', 'reply_to_json', 'inbox_category', 'inbox_category_v2', 'ai_inbox_category'
      ])
    );
    expect(tableColumns(db, 'workspace_users')).toEqual(
      new Set([
        'id', 'login_email', 'name', 'role', 'email', 'company', 'location', 'timezone', 'forwarding_enabled',
        'signature', 'incoming_sequence', 'created_at', 'updated_at'
      ])
    );
    expect(tableColumns(db, 'blocked_senders')).toEqual(new Set(['owner_user_id', 'email', 'created_at']));
    expect(tableColumns(db, 'mail_labels')).toEqual(new Set([
      'id', 'owner_user_id', 'name', 'name_key', 'created_at', 'updated_at'
    ]));
    expect(tableColumns(db, 'mail_message_labels')).toEqual(new Set([
      'owner_user_id', 'label_id', 'message_kind', 'message_id', 'created_at'
    ]));
    expect(tableColumns(db, 'workspace_owner')).toEqual(new Set(['singleton', 'user_id']));
    expect(tableColumns(db, 'workspace_auth_credentials')).toEqual(new Set(['user_id', 'username', 'credential_hash', 'updated_at']));
    expect(tableColumns(db, 'mail_domains')).toEqual(new Set([
      'id', 'owner_user_id', 'domain_name', 'cloudflare_zone_id', 'cloudflare_account_id', 'worker_name',
      'enabled', 'unknown_recipient_policy', 'catch_all_target', 'catch_all_checked_at', 'resend_domain_id',
      'resend_status', 'resend_sending_status', 'resend_checked_at', 'cloudflare_checked_at',
      'cloudflare_next_check_at', 'cloudflare_check_token', 'cloudflare_check_expires_at', 'cloudflare_error_code',
      'cloudflare_error_at', 'cloudflare_failure_count', 'resend_next_check_at', 'resend_check_token',
      'resend_check_expires_at', 'resend_error_code', 'resend_error_at', 'resend_failure_count',
      'last_error_code', 'last_error_at', 'created_at', 'updated_at'
    ]));
    expect(tableColumns(db, 'mail_addresses')).toEqual(new Set([
      'id', 'owner_user_id', 'domain_id', 'email', 'local_part', 'display_name', 'signature', 'receive_enabled',
      'send_enabled', 'lifecycle_status', 'routing_state', 'routing_rule_id', 'routing_rule_source',
      'routing_owner', 'is_default_sender', 'operation_token', 'operation_expires_at', 'delete_route_policy', 'last_error_code',
      'last_error_at', 'deleted_at', 'created_at', 'updated_at'
    ]));
    expect(tableColumns(db, 'workspace_drafts')).toEqual(
      new Set([
        'id', 'user_id', 'to_email', 'cc', 'to_json', 'cc_json', 'bcc_json', 'subject', 'body', 'is_starred', 'created_at', 'updated_at',
        'message_id', 'in_reply_to', 'references', 'thread_key', 'idempotency_key', 'body_object_id', 'deleted_at',
        'attachment_revision', 'sender_address_id', 'from_name', 'from_email', 'reply_to_json'
      ])
    );
    expect(tableColumns(db, 'workspace_search_documents')).toEqual(new Set([
      'id', 'user_id', 'entity_kind', 'entity_id', 'from_text', 'to_text', 'cc_text',
      'subject_text', 'body_text', 'labels_text', 'indexed_at', 'mail_address_id'
    ]));
    expect(tableColumns(db, 'workspace_search_fts')).toEqual(new Set([
      'from_text', 'to_text', 'cc_text', 'subject_text', 'body_text', 'labels_text'
    ]));
    expect(tableColumns(db, 'workspace_sessions')).toEqual(
      new Set(['id', 'user_id', 'created_at', 'updated_at', 'token_hash', 'expires_at', 'revoked_at', 'last_seen_at', 'auth_method', 'principal_id'])
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
        'id', 'user_id', 'message_id', 'filename', 'content_type', 'size', 'inline', 'content_id', 'r2_key', 'created_at',
        'relation_type', 'state', 'sha256', 'disposition', 'updated_at', 'delete_after'
      ])
    );
    expect(tableColumns(db, 'workspace_r2_cleanup_queue')).toEqual(new Set([
      'id', 'owner_user_id', 'entity_id', 'r2_key', 'reason', 'status', 'attempt_count', 'max_attempts',
      'next_attempt_at', 'claim_token', 'lease_expires_at', 'last_error', 'completed_at', 'object_kind', 'source_id',
      'source_owner_user_id', 'source_entity_id', 'created_at', 'updated_at'
    ]));
    expect(tableColumns(db, 'workspace_settings')).toEqual(
      new Set(['user_id', 'theme', 'settings_json', 'created_at', 'updated_at'])
    );
    expect(tableColumns(db, 'workspace_login_rate_limits')).toEqual(
      new Set(['identity_hash', 'attempt_count', 'window_started_at', 'reset_at', 'updated_at'])
    );
    expect(tableColumns(db, 'workspace_outbound_rate_limits')).toEqual(
      new Set(['user_id', 'attempt_count', 'window_started_at', 'reset_at', 'updated_at'])
    );
    expect(tableColumns(db, 'workspace_telegram_bindings')).toEqual(new Set([
      'user_id', 'binding_id', 'state', 'telegram_user_id', 'telegram_chat_id',
      'telegram_username', 'telegram_display_name', 'candidate_challenge_id',
      'candidate_expires_at', 'enabled', 'privacy_mode', 'summary_enabled', 'ai_summary_enabled',
      'authorization_version', 'bound_at', 'confirmed_at', 'revoked_at',
      'last_sent_at', 'last_error_code', 'last_error_at', 'created_at', 'updated_at'
    ]));
    expect(tableColumns(db, 'workspace_telegram_bind_challenges')).toEqual(new Set([
      'id', 'owner_user_id', 'token_hash', 'status', 'expires_at', 'consumed_at', 'consumed_update_id',
      'replaced_at', 'created_at', 'updated_at'
    ]));
    expect(tableColumns(db, 'workspace_telegram_updates')).toEqual(new Set([
      'update_id', 'processing_token', 'status', 'result_code', 'created_at', 'processed_at'
    ]));
    expect(tableColumns(db, 'workspace_telegram_deliveries')).toEqual(new Set([
      'id', 'owner_user_id', 'email_message_id', 'channel', 'binding_id',
      'authorization_version', 'privacy_mode', 'summary_enabled', 'ai_summary_enabled', 'ai_attempted', 'status', 'attempts', 'max_attempts', 'next_attempt_at',
      'claim_token', 'lease_expires_at', 'external_started', 'external_started_at',
      'telegram_message_id', 'last_error_code', 'last_error_at', 'completed_at',
      'created_at', 'updated_at'
    ]));
    expect(tableColumns(db, 'workspace_telegram_rate_limits')).toEqual(new Set([
      'user_id', 'action', 'attempt_count', 'window_started_at', 'reset_at', 'updated_at'
    ]));
    expect(tableColumns(db, 'workspace_telegram_delivery_limits')).toEqual(new Set([
      'scope', 'next_allowed_at', 'cooldown_until', 'updated_at'
    ]));
    expect(tableColumns(db, 'workspace_inbound_ingest_claims')).toEqual(
      new Set(['dedupe_key', 'storage_id', 'claim_token', 'raw_key', 'status', 'created_at', 'updated_at', 'completed_at'])
    );
    expect(tableColumns(db, 'workspace_email_states')).toEqual(
      new Set(['id', 'user_id', 'email_message_id', 'is_read', 'is_starred', 'deleted_at', 'archived_at', 'quarantined_at', 'created_at', 'updated_at'])
    );
    expect(db.query('SELECT schema_name, schema_version FROM workspace_schema_metadata').all()).toEqual([
      { schema_name: 'flaremail', schema_version: 41 }
    ]);

    expect(db.query(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'workspace_users_telegram_delete_cleanup'`).get())
      .toEqual({ name: 'workspace_users_telegram_delete_cleanup' });

    expect(indexNames(db, 'email_messages')).toEqual(
      new Set([
        'idx_email_messages_timestamp', 'idx_email_messages_from', 'idx_email_messages_to',
        'idx_email_messages_message_id', 'idx_email_messages_thread_key', 'idx_email_messages_dedupe_key',
        'idx_email_messages_provider_message_id', 'idx_email_messages_recipient_cursor', 'idx_email_messages_owner_cursor',
        'idx_email_messages_owner_address_cursor'
      ])
    );
    expect(indexNames(db, 'workspace_delivery_statuses')).toEqual(
      new Set([
        'idx_workspace_delivery_statuses_idempotency_key',
        'idx_workspace_delivery_statuses_provider_message_id',
        'idx_workspace_delivery_statuses_user_status'
      ])
    );
    expect(indexNames(db, 'workspace_messages')).toContain('idx_workspace_messages_user_folder_archived');
    expect(indexNames(db, 'workspace_messages')).toContain('idx_workspace_messages_user_trash');
    expect(indexNames(db, 'workspace_email_states')).toContain('idx_workspace_email_states_user_archived');
    expect(indexNames(db, 'workspace_email_states')).toContain('idx_workspace_email_states_user_trash');
    expect(indexNames(db, 'workspace_drafts')).toContain('idx_workspace_drafts_user_trash');
    expect(indexNames(db, 'workspace_search_documents')).toContain('idx_workspace_search_documents_owner');
    expect(indexNames(db, 'workspace_attachments')).toEqual(
      new Set([
        'idx_workspace_attachments_user_message', 'idx_workspace_attachments_content_id',
        'idx_workspace_attachments_user_relation', 'idx_workspace_attachments_cleanup'
      ])
    );
    expect(tableColumns(db, 'mail_body_objects')).toEqual(new Set([
      'id', 'owner_user_id', 'entity_type', 'entity_id', 'r2_key', 'size_bytes', 'sha256',
      'text_bytes', 'html_bytes', 'state', 'created_at', 'updated_at', 'delete_after'
    ]));
    expect(indexNames(db, 'workspace_login_rate_limits')).toEqual(
      new Set(['idx_workspace_login_rate_limits_reset_at'])
    );
    expect(indexNames(db, 'workspace_outbound_rate_limits')).toEqual(
      new Set(['idx_workspace_outbound_rate_limits_reset_at'])
    );
    expect(indexNames(db, 'workspace_telegram_bind_challenges')).toEqual(
      new Set(['idx_workspace_telegram_challenges_owner', 'idx_workspace_telegram_challenges_expiry'])
    );
    expect(indexNames(db, 'workspace_telegram_deliveries')).toEqual(
      new Set([
        'idx_workspace_telegram_deliveries_claim',
        'idx_workspace_telegram_deliveries_lease',
        'idx_workspace_telegram_deliveries_owner_history',
        'idx_workspace_telegram_deliveries_email'
      ])
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

  test('retains valid senderless RFC keys created by the legacy migration', () => {
    const db = createDatabase();
    applyMigrationsThrough(db, '0001_baseline.sql');
    db.exec(`INSERT INTO email_messages (id, message_id, "from", "to", subject, "timestamp", raw_key) VALUES
      ('legacy-rfc-a', '<root@example.test>', '', 'owner@example.test', 'First', '2026-08-13T00:00:00Z', 'raw/a'),
      ('legacy-rfc-b', '<root@example.test>', '', 'owner@example.test', 'Second', '2026-08-13T00:01:00Z', 'raw/b');`);
    applyMigrations(db);
    const rows = db.query(`SELECT message_id, in_reply_to, "references", thread_key FROM email_messages ORDER BY id`).all() as Array<{ message_id: string; in_reply_to: string | null; references: string | null; thread_key: string }>;
    expect(rows.map(({ thread_key }) => thread_key)).toEqual(['rfc:<root@example.test>', 'rfc:<root@example.test>']);
    expect(rows.every((row) => hasReliableThreadContext('', row))).toBe(true);
    db.close();
  });

  test('quarantines unverifiable legacy cleanup rows during migration', () => {
    const db = createDatabase();
    applyMigrationsThrough(db, '0016_outbound_attachments.sql');
    db.query(`INSERT INTO workspace_r2_cleanup_queue (id, owner_user_id, entity_id, r2_key, reason, created_at, updated_at) VALUES ('legacy-job', 'owner-1', 'message-1', 'sent/att-1', 'trash_delete', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`).run();
    db.exec(readFileSync(join(migrationsDirectory, '0017_r2_cleanup_queue_reliability.sql'), 'utf8'));
    expect(db.query(`SELECT status, object_kind, attempt_count, next_attempt_at, last_error FROM workspace_r2_cleanup_queue WHERE id = 'legacy-job'`).get())
      .toEqual({ status: 'manual_review', object_kind: 'legacy', attempt_count: 0, next_attempt_at: '2026-08-20T00:00:00.000Z', last_error: 'invalid_key_scope' });
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
      `SELECT message_id, thread_key, dedupe_key, direction, text_body, html_body, owner_user_id,
        to_json, reply_to_json, headers_json, authentication_results_json, mail_domain_id, mail_address_id, recipient_status
       FROM email_messages WHERE id = 'legacy-email-1'`
    ).get() as Record<string, string | null>;
    expect(inbound).toMatchObject({
      message_id: '<legacy-1@example.test>',
      thread_key: 'rfc:<legacy-1@example.test>',
      dedupe_key: 'rfc:<legacy-1@example.test>:to:admin@example.test',
      direction: 'inbound',
      text_body: 'Legacy body',
      html_body: '',
      owner_user_id: 'legacy-user-1',
      to_json: '[{"name":"","email":"admin@example.test"}]',
      reply_to_json: '[]',
      headers_json: '[]',
      authentication_results_json: '[]',
      mail_domain_id: null,
      mail_address_id: null,
      recipient_status: 'legacy-unmapped'
    });
    expect(tableCount(db, 'mail_domains')).toBe(0);
    expect(tableCount(db, 'mail_addresses')).toBe(0);
    expect(db.query(`SELECT sender_address_id, recipient_address_id FROM workspace_messages WHERE id = 'legacy-message-2'`).get())
      .toEqual({ sender_address_id: null, recipient_address_id: null });
    expect(db.query(`SELECT sender_address_id, from_email FROM workspace_drafts WHERE id = 'legacy-draft-1'`).get())
      .toEqual({ sender_address_id: null, from_email: '' });

    const workspaceInbound = db.query(
      `SELECT direction, text_body, thread_key, dedupe_key
       FROM workspace_messages WHERE id = 'legacy-message-1'`
    ).get() as Record<string, string>;
    expect(workspaceInbound).toMatchObject({
      direction: 'inbound', text_body: 'Legacy body', thread_key: 'legacy:legacy-message-1', dedupe_key: 'legacy:legacy-message-1'
    });

    expect(db.query(`SELECT to_json FROM workspace_messages WHERE id = 'legacy-message-2'`).get()).toEqual({
      to_json: '[{"name":"","email":"recipient@example.test"}]'
    });
    expect(db.query(`SELECT to_json FROM workspace_drafts WHERE id = 'legacy-draft-1'`).get()).toEqual({
      to_json: '[{"name":"","email":"recipient@example.test"}]'
    });
    expect(db.query(`SELECT entity_kind, entity_id FROM workspace_search_documents ORDER BY entity_kind, entity_id`).all())
      .toEqual([
        { entity_kind: 'draft', entity_id: 'legacy-draft-1' },
        { entity_kind: 'inbound', entity_id: 'legacy-email-1' },
        { entity_kind: 'message', entity_id: 'legacy-message-1' },
        { entity_kind: 'message', entity_id: 'legacy-message-2' }
      ]);
    expect(db.query(`SELECT COUNT(*) AS count FROM workspace_search_fts WHERE workspace_search_fts MATCH 'legacy'`).get())
      .toEqual({ count: 3 });

    const session = db.query(
      `SELECT token_hash, expires_at, last_seen_at FROM workspace_sessions WHERE id = 'legacy-session-1'`
    ).get() as Record<string, string | null>;
    expect(session.token_hash).toBeNull();
    expect(session.expires_at).toBe('2026-09-11 11:00:00');
    expect(session.last_seen_at).toBe('2026-08-12T11:00:00.000Z');
    expect(tableCount(db, 'workspace_settings')).toBe(1);
    expect(db.query(`SELECT theme FROM workspace_settings WHERE user_id = 'legacy-user-1'`).get()).toEqual({ theme: 'system' });
    expect(db.query('SELECT singleton, user_id FROM workspace_owner').all()).toEqual([
      { singleton: 1, user_id: 'legacy-user-1' }
    ]);
    expect(db.query(`SELECT username, credential_hash FROM workspace_auth_credentials`).all()).toEqual([]);

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

  test('does not choose an Owner when multiple historical users exist', () => {
    const db = createDatabase();
    applyMigrationsThrough(db, '0022_telegram_delivery_privacy_snapshot.sql');
    db.query(`INSERT INTO workspace_users (
      id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature
    ) VALUES
      ('user-a', 'a@example.test', 'A', 'Owner', '', '', '', 'UTC', 1, ''),
      ('user-b', 'b@example.test', 'B', 'Owner', '', '', '', 'UTC', 1, '')`).run();
    db.query(`UPDATE workspace_users SET credential_hash = 'hash-a' WHERE id = 'user-a'`).run();
    db.query(`UPDATE workspace_users SET credential_hash = 'hash-b' WHERE id = 'user-b'`).run();

    db.exec(readFileSync(join(migrationsDirectory, '0023_owner_principal_auth.sql'), 'utf8'));

    expect(tableCount(db, 'workspace_owner')).toBe(0);
    expect(db.query('SELECT user_id, username, credential_hash FROM workspace_auth_credentials ORDER BY user_id').all()).toEqual([
      { user_id: 'user-a', username: 'a@example.test', credential_hash: 'hash-a' },
      { user_id: 'user-b', username: 'b@example.test', credential_hash: 'hash-b' }
    ]);
    expect(db.query('SELECT id, login_email, email FROM workspace_users ORDER BY id').all()).toEqual([
      { id: 'user-a', login_email: 'a@example.test', email: '' },
      { id: 'user-b', login_email: 'b@example.test', email: '' }
    ]);
  });
});

test('migration 0031 keeps pre-existing Telegram AI authorization and attempts off', () => {
  const db = createDatabase();
  applyMigrationsThrough(db, '0030_mail_ai_analyses.sql');
  db.exec(`INSERT INTO workspace_users (id, name, role, email, company, location, timezone, signature)
      VALUES ('owner', 'Owner', 'Owner', '', '', '', 'UTC', '');
    INSERT INTO workspace_telegram_bindings (user_id, binding_id, state, telegram_user_id, telegram_chat_id, enabled, summary_enabled, created_at, updated_at)
      VALUES ('owner', 'binding', 'active', '42', '42', 1, 1, 'now', 'now');
    INSERT INTO workspace_telegram_deliveries (id, owner_user_id, email_message_id, binding_id, authorization_version, status, summary_enabled, next_attempt_at, created_at, updated_at)
      VALUES ('delivery', 'owner', 'mail', 'binding', 1, 'pending', 1, 'now', 'now', 'now');`);
  applyMigrations(db);
  expect(db.query('SELECT ai_summary_enabled FROM workspace_telegram_bindings').get()).toEqual({ ai_summary_enabled: 0 });
  expect(db.query('SELECT ai_summary_enabled, ai_attempted FROM workspace_telegram_deliveries').get())
    .toEqual({ ai_summary_enabled: 0, ai_attempted: 0 });
});

test('migration 0032 preserves raw manual choices, folds retired categories and starts without AI jobs', () => {
  const db = createDatabase(); applyMigrationsThrough(db, '0031_telegram_ai_summary.sql');
  db.exec(`INSERT INTO workspace_users (id,name,role,email) VALUES ('owner','Owner','Owner','owner@example.test');
    INSERT INTO email_messages (id,owner_user_id,"from","to",subject,timestamp,raw_key,inbox_category)
      VALUES ('social','owner','sender@example.test','owner@example.test','Hello','now','raw/social','social'),
      ('automatic','owner','sender@example.test','owner@example.test','Hello','now','raw/auto',NULL);
    INSERT INTO workspace_messages (id,user_id,folder,from_name,from_email,to_name,to_email,subject,preview,body,sent_at,labels_json,is_read,is_starred,created_at,updated_at,inbox_category)
      VALUES ('forum','owner','inbox','Sender','sender@example.test','Owner','owner@example.test','','','','now','[]',0,0,'now','now','forums');
    INSERT INTO mail_ai_analyses VALUES ('owner','inbound','social','hash','fake',2,'ready','{}','claim',0,1000,2000);`);
  applyMigrations(db);
  expect(db.query('SELECT id,inbox_category,inbox_category_v2,ai_inbox_category FROM email_messages ORDER BY id').all()).toEqual([
    { id: 'automatic', inbox_category: null, inbox_category_v2: null, ai_inbox_category: null },
    { id: 'social', inbox_category: 'social', inbox_category_v2: 'updates', ai_inbox_category: null }
  ]);
  expect(db.query('SELECT inbox_category,inbox_category_v2 FROM workspace_messages').get()).toEqual({ inbox_category: 'forums', inbox_category_v2: 'updates' });
  expect(db.query('SELECT result_updated_at FROM mail_ai_analyses').get()).toEqual({ result_updated_at: 2000 });
  expect(tableCount(db, 'mail_ai_jobs')).toBe(0);
  db.close();
});
