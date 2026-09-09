import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { createTelegramChallenge } from '$lib/server/db/telegram';
import { FLAREMAIL_SCHEMA_VERSION } from '$lib/server/db/schema-version';
import { sha256Base64Url } from '$lib/server/telegram/utils';
import { POST } from './+server';

class Statement {
  private values: unknown[] = [];
  constructor(private readonly db: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this as unknown as D1PreparedStatement; }
  first<T>() { return Promise.resolve((this.db.query(this.sql).get(...this.values as never[]) as T | null) ?? null); }
  all<T>() { return Promise.resolve({ success: true, results: this.db.query(this.sql).all(...this.values as never[]) as T[] }); }
  runSync<T>() { const result = this.db.query(this.sql).run(...this.values as never[]); return { success: true, results: [] as T[], meta: { changes: Number(result.changes ?? 0) } }; }
  run<T>() { return Promise.resolve(this.runSync<T>()); }
}

class TestD1 {
  constructor(readonly db: Database) {}
  prepare(sql: string) { return new Statement(this.db, sql) as unknown as D1PreparedStatement; }
  batch(statements: D1PreparedStatement[]) { return Promise.resolve(this.db.transaction(() => statements.map((statement) => (statement as unknown as Statement).runSync()))()); }
}

function fixture() {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../../../../../schema.sql', import.meta.url), 'utf8'));
  db.query(`INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
    VALUES ('flaremail', ?, '2026-09-09T00:00:00.000Z')`).run(FLAREMAIL_SCHEMA_VERSION);
  db.query(`INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence)
    VALUES ('user-1', 'owner@example.test', 'Owner', 'Owner', 'owner@example.test', '', '', 'UTC', 0, '', 0)`).run();
  const DB = new TestD1(db);
  return {
    db,
    DB,
    env: {
      DB,
      BUCKET: {},
      APP_ENV: 'test',
      ALLOW_FAKE_SERVICES: 'true',
      OUTBOUND_PROVIDER: 'demo',
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
      TELEGRAM_WEBHOOK_SECRET: 'test-telegram-webhook-secret',
      TELEGRAM_BOT_USERNAME: 'flaremail_bot',
      APP_BASE_URL: 'http://127.0.0.1:8787'
    }
  } as const;
}

function event(env: unknown, body: unknown, secret = 'test-telegram-webhook-secret') {
  return {
    request: new Request('https://mail.example.test/api/webhooks/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(body)
    }),
    platform: { env }
  } as never;
}

describe('Telegram webhook', () => {
  test('rejects an invalid secret before parsing or touching D1', async () => {
    let touched = false;
    const response = await POST(event({
      get DB() { touched = true; throw new Error('D1 should not be touched'); },
      BUCKET: {}
    }, { invalid: true }, 'wrong-secret'));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(touched).toBe(false);
  });

  test('binds only a private non-bot chat and deduplicates Telegram retries', async () => {
    const fixtureData = fixture();
    const token = 'A'.repeat(43);
    await createTelegramChallenge(fixtureData.DB as unknown as D1Database, 'user-1', 'challenge-1', await sha256Base64Url(token), '2999-01-01T00:00:00.000Z');
    const update = {
      update_id: 101,
      message: {
        text: `/start ${token}`,
        from: { id: 42, is_bot: false, username: 'alice', first_name: 'Alice' },
        chat: { id: 42, type: 'private' }
      }
    };
    expect((await POST(event(fixtureData.env, update))).status).toBe(200);
    expect((await POST(event(fixtureData.env, update))).status).toBe(200);
    expect(fixtureData.db.query(`SELECT state, telegram_chat_id, enabled FROM workspace_telegram_bindings WHERE user_id = 'user-1'`).get())
      .toEqual({ state: 'candidate', telegram_chat_id: '42', enabled: 0 });
    expect(fixtureData.db.query(`SELECT status, result_code FROM workspace_telegram_updates WHERE update_id = '101'`).get())
      .toEqual({ status: 'processed', result_code: 'bound' });
  });

  test('ignores groups and messages whose sender is not the private chat owner', async () => {
    const fixtureData = fixture();
    const group = { update_id: 201, message: { text: '/start AAA', from: { id: 42, is_bot: false }, chat: { id: -42, type: 'group' } } };
    const mismatch = { update_id: 202, message: { text: '/start AAA', from: { id: 42, is_bot: false }, chat: { id: 43, type: 'private' } } };
    const missingBotFlag = { update_id: 203, message: { text: '/start AAA', from: { id: 43 }, chat: { id: 43, type: 'private' } } };
    const forwarded = { update_id: 204, message: { text: '/start AAA', from: { id: 43, is_bot: false }, chat: { id: 43, type: 'private' }, forward_origin: { type: 'user' } } };
    await POST(event(fixtureData.env, group));
    await POST(event(fixtureData.env, mismatch));
    await POST(event(fixtureData.env, missingBotFlag));
    await POST(event(fixtureData.env, forwarded));
    expect(fixtureData.db.query(`SELECT COUNT(*) AS count FROM workspace_telegram_bindings`).get()).toEqual({ count: 0 });
    expect(fixtureData.db.query(`SELECT COUNT(*) AS count FROM workspace_telegram_updates WHERE status = 'ignored'`).get()).toEqual({ count: 4 });
  });

  test('atomically revokes a binding and cancels unsent deliveries on /stop', async () => {
    const fixtureData = fixture();
    fixtureData.db.query(`INSERT INTO workspace_telegram_bindings
      (user_id, binding_id, state, telegram_user_id, telegram_chat_id, enabled, candidate_challenge_id,
       candidate_expires_at, authorization_version, created_at, updated_at)
      VALUES ('user-1', 'binding-1', 'active', '42', '42', 1, 'challenge-used', '2999-01-01T00:00:00.000Z', 1,
        '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`).run();
    fixtureData.db.query(`INSERT INTO email_messages (id, "from", "to", subject, timestamp, raw_key, dedupe_key, owner_user_id)
      VALUES ('email-1', 'sender@example.test', 'owner@example.test', 'Subject', '2026-09-09T12:00:00.000Z', 'raw/email-1', 'dedupe-1', 'user-1')`).run();
    fixtureData.db.query(`INSERT INTO workspace_telegram_deliveries
      (id, owner_user_id, email_message_id, channel, binding_id, authorization_version, status,
       next_attempt_at, created_at, updated_at)
      VALUES ('delivery-1', 'user-1', 'email-1', 'telegram', 'binding-1', 1, 'pending',
        '2026-09-09T12:00:00.000Z', '2026-09-09T12:00:00.000Z', '2026-09-09T12:00:00.000Z')`).run();

    expect((await POST(event(fixtureData.env, {
      update_id: 301,
      message: {
        text: '/stop',
        from: { id: 42, is_bot: false },
        chat: { id: 42, type: 'private' }
      }
    }))).status).toBe(200);
    expect(fixtureData.db.query(`SELECT state, enabled, telegram_chat_id, candidate_challenge_id, authorization_version
      FROM workspace_telegram_bindings WHERE user_id = 'user-1'`).get()).toEqual({
      state: 'revoked', enabled: 0, telegram_chat_id: null, candidate_challenge_id: null, authorization_version: 2
    });
    expect(fixtureData.db.query(`SELECT status, completed_at FROM workspace_telegram_deliveries WHERE id = 'delivery-1'`).get()).toMatchObject({ status: 'cancelled' });
    expect(fixtureData.db.query(`SELECT status, result_code FROM workspace_telegram_updates WHERE update_id = '301'`).get())
      .toEqual({ status: 'ignored', result_code: 'stop' });

    fixtureData.db.query(`INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence)
      VALUES ('user-2', 'second@example.test', 'Second', 'Owner', 'second@example.test', '', '', 'UTC', 0, '', 0)`).run();
    fixtureData.db.query(`INSERT INTO workspace_telegram_bindings
      (user_id, binding_id, state, telegram_user_id, telegram_chat_id, enabled, authorization_version, created_at, updated_at)
      VALUES ('user-2', 'binding-2', 'active', '42', '42', 1, 1, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`).run();
    await POST(event(fixtureData.env, {
      update_id: 301,
      message: {
        text: '/stop',
        from: { id: 42, is_bot: false },
        chat: { id: 42, type: 'private' }
      }
    }));
    expect(fixtureData.db.query(`SELECT state, enabled FROM workspace_telegram_bindings WHERE user_id = 'user-2'`).get())
      .toEqual({ state: 'active', enabled: 1 });
  });
});
