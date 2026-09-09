import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { dispatchTelegramOutbox } from './dispatcher';
import { formatTelegramReceivedAt } from './message';
import type { CloudflareEnv } from '$lib/server/cloudflare';

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

function fixture(status: 'pending' | 'retryable' = 'pending') {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
  db.query(`INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence)
    VALUES ('user-1', 'owner@example.test', 'Owner', 'Owner', 'owner@example.test', '', '', 'UTC', 0, '', 0)`).run();
  db.query(`INSERT INTO workspace_telegram_bindings
    (user_id, binding_id, state, telegram_user_id, telegram_chat_id, telegram_username, enabled, privacy_mode, summary_enabled, authorization_version, created_at, updated_at)
    VALUES ('user-1', 'binding-1', 'active', '42', '42', 'alice', 1, 0, 1, 1, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`).run();
  db.query(`INSERT INTO email_messages (id, "from", "to", subject, timestamp, snippet, raw_key, dedupe_key, owner_user_id, created_at)
    VALUES ('email-1', 'Sender <sender@example.test>', 'owner@example.test', 'Subject', '2000-01-01T00:00:00.000Z', 'A bounded summary.', 'raw/email-1', 'dedupe-1', 'user-1', '2026-09-09T12:34:00.000Z')`).run();
  db.query(`INSERT INTO workspace_telegram_deliveries
    (id, owner_user_id, email_message_id, channel, binding_id, authorization_version, privacy_mode, summary_enabled, status, next_attempt_at, created_at, updated_at)
    VALUES ('delivery-1', 'user-1', 'email-1', 'telegram', 'binding-1', 1, 0, 1, ?, '2026-09-09T11:00:00.000Z', '2026-09-09T11:00:00.000Z', '2026-09-09T11:00:00.000Z')`).run(status);
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

describe('Telegram outbox dispatcher', () => {
  test('claims, sends, and records the provider message id with a trusted mailbox button', async () => {
    const value = fixture();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const result = await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, {
      limit: 1,
      now: () => Date.parse('2026-09-09T12:00:00.000Z'),
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9001 } }), { status: 200 });
      }
    });
    expect(result).toMatchObject({ processed: 1, sent: 1, failed: 0, unknown: 0 });
    expect(requests[0]?.url).toBe('https://api.telegram.org/bot123456:abcdefghijklmnopqrstuvwxyz/sendMessage');
    expect(String(requests[0]?.body.text)).toContain('摘要：A bounded summary.');
    expect(String(requests[0]?.body.text)).toContain(`收到时间：${formatTelegramReceivedAt('2026-09-09T12:34:00.000Z', 'UTC')}`);
    expect(JSON.stringify(requests[0]?.body)).not.toContain('raw/email-1');
    expect(value.db.query(`SELECT status, telegram_message_id FROM workspace_telegram_deliveries`).get())
      .toEqual({ status: 'sent', telegram_message_id: '9001' });
  });

  test('turns a provider 403 into a terminal failed row and transport uncertainty into unknown_delivery', async () => {
    const permanent = fixture();
    const permanentResult = await dispatchTelegramOutbox(permanent.env as unknown as CloudflareEnv, {
      limit: 1,
      now: () => Date.parse('2026-09-09T12:00:00.000Z'),
      fetchImpl: async () => new Response(JSON.stringify({ ok: false, error_code: 403, description: 'blocked' }), { status: 403 })
    });
    expect(permanentResult.failed).toBe(1);
    expect(permanent.db.query('SELECT status, last_error_code FROM workspace_telegram_deliveries').get()).toEqual({ status: 'failed', last_error_code: 'telegram_403' });

    const unknown = fixture();
    const unknownResult = await dispatchTelegramOutbox(unknown.env as unknown as CloudflareEnv, { limit: 1, now: () => Date.parse('2026-09-09T12:00:00.000Z'), fetchImpl: async () => { throw new Error('socket closed'); } });
    expect(unknownResult.unknown).toBe(1);
    expect(unknown.db.query('SELECT status, last_error_code FROM workspace_telegram_deliveries').get()).toEqual({ status: 'unknown_delivery', last_error_code: 'unknown_transport' });
  });

  test('does not expand a queued summary and applies a newly enabled privacy mode', async () => {
    const queued = fixture();
    queued.db.query(`UPDATE workspace_telegram_deliveries SET summary_enabled = 0 WHERE id = 'delivery-1'`).run();
    const queuedRequests: Array<Record<string, unknown>> = [];
    await dispatchTelegramOutbox(queued.env as unknown as CloudflareEnv, {
      limit: 1,
      now: () => Date.parse('2026-09-09T12:00:00.000Z'),
      fetchImpl: async (_input, init) => {
        queuedRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9002 } }), { status: 200 });
      }
    });
    expect(String(queuedRequests[0]?.text)).not.toContain('摘要：');

    const privateMode = fixture();
    privateMode.db.query(`UPDATE workspace_telegram_bindings SET privacy_mode = 1 WHERE user_id = 'user-1'`).run();
    const privateRequests: Array<Record<string, unknown>> = [];
    await dispatchTelegramOutbox(privateMode.env as unknown as CloudflareEnv, {
      limit: 1,
      now: () => Date.parse('2026-09-09T12:00:00.000Z'),
      fetchImpl: async (_input, init) => {
        privateRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9003 } }), { status: 200 });
      }
    });
    expect(privateRequests[0]?.text).toBe('FlareMail：收到一封新邮件。');
  });

  test('does not claim a row whose binding authorization was revoked', async () => {
    const value = fixture('retryable');
    value.db.query(`UPDATE workspace_telegram_bindings SET state = 'revoked', enabled = 0, telegram_chat_id = NULL WHERE user_id = 'user-1'`).run();
    let calls = 0;
    const result = await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, { limit: 1, fetchImpl: async () => { calls += 1; return new Response('{}'); } });
    expect(result.processed).toBe(0);
    expect(calls).toBe(0);
    expect(value.db.query('SELECT status FROM workspace_telegram_deliveries').get()).toEqual({ status: 'retryable' });
  });
});
