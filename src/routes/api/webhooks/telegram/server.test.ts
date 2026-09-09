import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { createTelegramChallenge } from '$lib/server/db/telegram';
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
    await POST(event(fixtureData.env, group));
    await POST(event(fixtureData.env, mismatch));
    expect(fixtureData.db.query(`SELECT COUNT(*) AS count FROM workspace_telegram_bindings`).get()).toEqual({ count: 0 });
    expect(fixtureData.db.query(`SELECT COUNT(*) AS count FROM workspace_telegram_updates WHERE status = 'ignored'`).get()).toEqual({ count: 2 });
  });
});
