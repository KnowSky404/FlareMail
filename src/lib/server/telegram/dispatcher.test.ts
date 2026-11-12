import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { dispatchTelegramOutbox } from './dispatcher';
import { formatTelegramReceivedAt } from './message';
import { FLAREMAIL_SCHEMA_VERSION } from '$lib/server/db/schema-version';
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
  db.query(`INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
    VALUES ('flaremail', ?, '2026-09-09T00:00:00.000Z')`).run(FLAREMAIL_SCHEMA_VERSION);
  db.query(`INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence)
    VALUES ('user-1', 'owner@example.test', 'Owner', 'Owner', 'owner@example.test', '', '', 'UTC', 0, '', 0)`).run();
  db.query(`INSERT INTO workspace_telegram_bindings
    (user_id, binding_id, state, telegram_user_id, telegram_chat_id, telegram_username, enabled, privacy_mode, summary_enabled, authorization_version, created_at, updated_at)
    VALUES ('user-1', 'binding-1', 'active', '42', '42', 'alice', 1, 0, 1, 1, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`).run();
  db.query(`INSERT INTO email_messages (id, "from", "to", subject, timestamp, snippet, raw_key, dedupe_key, owner_user_id, created_at, mail_address_id, recipient_status)
    VALUES ('email-1', 'Sender <sender@example.test>', 'owner@example.test', 'Subject', '2000-01-01T00:00:00.000Z', 'A bounded summary.', 'raw/email-1', 'dedupe-1', 'user-1', '2026-09-09T12:34:00.000Z', 'address-1', 'managed')`).run();
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

  test('pauses the durable bot scope after a Telegram server failure', async () => {
    const value = fixture();
    const now = Date.parse('2026-09-09T12:00:00.000Z');
    const result = await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, {
      limit: 1,
      now: () => now,
      fetchImpl: async () => new Response(JSON.stringify({ ok: false, error_code: 500, description: 'server error' }), { status: 500 })
    });

    expect(result.retryable).toBe(1);
    const cooldown = value.db.query(`SELECT cooldown_until FROM workspace_telegram_delivery_limits WHERE scope = 'bot'`).get() as { cooldown_until: string };
    expect(Date.parse(cooldown.cooldown_until)).toBeGreaterThan(now);
    expect(value.db.query('SELECT status FROM workspace_telegram_deliveries').get()).toEqual({ status: 'retryable' });
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

  test('cancels a row whose binding authorization was revoked before delivery', async () => {
    const value = fixture('retryable');
    value.db.query(`UPDATE workspace_telegram_bindings SET state = 'revoked', enabled = 0, telegram_chat_id = NULL WHERE user_id = 'user-1'`).run();
    let calls = 0;
    const result = await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, { limit: 1, fetchImpl: async () => { calls += 1; return new Response('{}'); } });
    expect(result.processed).toBe(0);
    expect(calls).toBe(0);
    expect(value.db.query('SELECT status FROM workspace_telegram_deliveries').get()).toEqual({ status: 'cancelled' });
  });
});

function aiFixture() {
  const value = fixture();
  value.db.exec(`UPDATE workspace_telegram_bindings SET ai_summary_enabled = 1;
    UPDATE workspace_telegram_deliveries SET ai_summary_enabled = 1;
    UPDATE email_messages SET text_body = 'Meeting tomorrow.';`);
  Object.assign(value.env, { AI_ENABLED: 'true', AI_BASE_URL: 'https://maas.vendor.com/v1', AI_API_KEY: 'fake-key', AI_MODEL: 'fake-model' });
  let calls = 0;
  const provider = { analyze: async (input: import('$lib/domain/mail/ai').MailAiInput) => {
    calls++;
    expect(value.db.query('SELECT external_started, ai_attempted FROM workspace_telegram_deliveries').get())
      .toEqual({ external_started: 0, ai_attempted: 1 });
    return { summary: 'AI meeting summary', keyPoints: [], actionItems: [], dates: [], language: input.language, suggestion: null };
  } };
  return { ...value, provider, calls: () => calls };
}

const dispatchTime = Date.parse('2026-09-09T12:00:00.000Z');
const telegramSuccess = () => new Response(JSON.stringify({ ok: true, result: { message_id: 9004 } }), { status: 200 });

test('generates and sends one AI summary; Telegram retry reuses cache without another generation', async () => {
  const value = aiFixture();
  const texts: string[] = [];
  const first = await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, {
    limit: 1, now: () => dispatchTime, aiProvider: value.provider,
    fetchImpl: async (_input, init) => {
      texts.push(String(JSON.parse(String(init?.body)).text));
      return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 1 } }), { status: 429 });
    }
  });
  expect(first.retryable).toBe(1);
  const second = await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, {
    limit: 1, now: () => dispatchTime + 10_000, aiProvider: value.provider,
    fetchImpl: async (_input, init) => { texts.push(String(JSON.parse(String(init?.body)).text)); return telegramSuccess(); }
  });
  expect(second.sent).toBe(1);
  expect(value.calls()).toBe(1);
  expect(texts).toHaveLength(2);
  expect(texts.every((text) => text.includes('AI 摘要：AI meeting summary'))).toBe(true);
});

test('AI failure falls back to the snippet and does not retry the provider after manual delivery retry', async () => {
  const value = aiFixture();
  let aiCalls = 0;
  const texts: string[] = [];
  const aiProvider = { analyze: async () => { aiCalls++; throw new Error('synthetic timeout'); } };
  const options = {
    limit: 1, now: () => dispatchTime, aiProvider,
    fetchImpl: async (_input: unknown, init?: RequestInit) => {
      texts.push(String(JSON.parse(String(init?.body)).text));
      return new Response(JSON.stringify({ ok: false, error_code: 403 }), { status: 403 });
    }
  };
  expect((await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, options)).failed).toBe(1);
  const { retryTelegramDelivery } = await import('$lib/server/db/telegram');
  expect(await retryTelegramDelivery(value.DB as unknown as D1Database, 'user-1', 'delivery-1')).toBe(true);
  expect((await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, {
    ...options, now: () => Date.now() + 1_000, fetchImpl: async (_input, init) => {
      texts.push(String(JSON.parse(String(init?.body)).text)); return telegramSuccess();
    }
  })).sent).toBe(1);
  expect(aiCalls).toBe(1);
  expect(texts.every((text) => text.includes('摘要：A bounded summary.') && !text.includes('AI 摘要'))).toBe(true);
});

test('a two-second inbound budget defers AI work without spending a delivery or AI attempt', async () => {
  const value = aiFixture();
  let sends = 0;
  await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, {
    limit: 1, timeBudgetMs: 2_000, now: () => dispatchTime, aiProvider: value.provider,
    fetchImpl: async () => { sends++; return telegramSuccess(); }
  });
  expect(value.calls()).toBe(0); expect(sends).toBe(0);
  expect(value.db.query('SELECT status, attempts, ai_attempted, external_started FROM workspace_telegram_deliveries').get())
    .toEqual({ status: 'pending', attempts: 0, ai_attempted: 0, external_started: 0 });
  expect((await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, {
    limit: 1, now: () => dispatchTime + 10_000, aiProvider: value.provider, fetchImpl: async () => telegramSuccess()
  })).sent).toBe(1);
  expect(value.calls()).toBe(1);
});

test.each([
  "UPDATE workspace_telegram_bindings SET ai_summary_enabled = 0",
  "UPDATE workspace_telegram_deliveries SET ai_summary_enabled = 0",
  "UPDATE workspace_telegram_bindings SET privacy_mode = 1",
  "UPDATE workspace_telegram_deliveries SET privacy_mode = 1",
  "UPDATE workspace_telegram_bindings SET summary_enabled = 0",
  "UPDATE workspace_telegram_deliveries SET summary_enabled = 0"
])('does not call AI without both snapshot and current consent: %s', async (sql) => {
  const value = aiFixture(); value.db.exec(sql);
  expect((await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, {
    limit: 1, now: () => dispatchTime, aiProvider: value.provider, fetchImpl: async () => telegramSuccess()
  })).sent).toBe(1);
  expect(value.calls()).toBe(0);
});

test.each(['privacy', 'summary', 'ai', 'binding', 'deleted'])('rechecks %s changes while AI is running before sending', async (change) => {
  const value = aiFixture();
  const texts: string[] = [];
  const sql = {
    privacy: 'UPDATE workspace_telegram_bindings SET privacy_mode = 1',
    summary: 'UPDATE workspace_telegram_bindings SET summary_enabled = 0',
    ai: 'UPDATE workspace_telegram_bindings SET ai_summary_enabled = 0',
    binding: 'UPDATE workspace_telegram_bindings SET enabled = 0',
    deleted: "INSERT INTO workspace_email_states (id, user_id, email_message_id, deleted_at) VALUES ('state', 'user-1', 'email-1', 'now')"
  }[change]!;
  const result = await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, {
    limit: 1, now: () => dispatchTime,
    aiProvider: { analyze: async (input) => { const analysis = await value.provider.analyze(input); value.db.exec(sql); return analysis; } },
    fetchImpl: async (_input, init) => { texts.push(String(JSON.parse(String(init?.body)).text)); return telegramSuccess(); }
  });
  if (change === 'binding' || change === 'deleted') { expect(result.sent).toBe(0); expect(texts).toHaveLength(0); }
  else {
    expect(result.sent).toBe(1); expect(texts[0]).not.toContain('AI 摘要');
    if (change === 'privacy') expect(texts[0]).toBe('FlareMail：收到一封新邮件。');
    else if (change === 'summary') expect(texts[0]).not.toContain('摘要：');
    else expect(texts[0]).toContain('摘要：A bounded summary.');
  }
});

test.each(['disabled', 'unconfigured', 'empty', 'quota', 'interrupted'])('optional AI %s falls back without blocking Telegram', async (state) => {
  const value = aiFixture();
  if (state === 'disabled') Object.assign(value.env, { AI_ENABLED: 'false' });
  if (state === 'unconfigured') Object.assign(value.env, { AI_API_KEY: '' });
  if (state === 'empty') value.db.exec("UPDATE email_messages SET text_body = ''");
  if (state === 'quota') value.db.query('INSERT INTO mail_ai_rate_limits (owner_user_id, attempts, reset_at) VALUES (?, 30, ?)').run('user-1', Date.now() + 60_000);
  if (state === 'interrupted') value.db.exec('UPDATE workspace_telegram_deliveries SET ai_attempted = 1');
  let text = '';
  expect((await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, {
    limit: 1, now: () => dispatchTime, aiProvider: value.provider,
    fetchImpl: async (_input, init) => { text = String(JSON.parse(String(init?.body)).text); return telegramSuccess(); }
  })).sent).toBe(1);
  expect(value.calls()).toBe(0);
  expect(text).toContain('摘要：A bounded summary.'); expect(text).not.toContain('AI 摘要');
});

test('globally disabled Telegram does not dispatch or analyze', async () => {
  const value = aiFixture(); Object.assign(value.env, { TELEGRAM_ENABLED: 'false' });
  let sends = 0;
  expect((await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, {
    aiProvider: value.provider, fetchImpl: async () => { sends++; return telegramSuccess(); }
  })).processed).toBe(0);
  expect(sends).toBe(0); expect(value.calls()).toBe(0);
});

test('expired AI delivery leases remain recoverable and the next dispatcher reuses the completed analysis', async () => {
  const value = aiFixture();
  let clock = dispatchTime;
  let sends = 0;
  const aiProvider = { analyze: async (input: import('$lib/domain/mail/ai').MailAiInput) => {
    const analysis = await value.provider.analyze(input);
    clock += 46_000;
    return analysis;
  } };
  const fetchImpl = async () => { sends++; return telegramSuccess(); };
  expect((await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, {
    limit: 1, now: () => clock, aiProvider, fetchImpl
  })).sent).toBe(0);
  expect(value.db.query('SELECT status, external_started, ai_attempted FROM workspace_telegram_deliveries').get())
    .toEqual({ status: 'processing', external_started: 0, ai_attempted: 1 });
  expect((await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, {
    limit: 1, now: () => clock, aiProvider, fetchImpl
  })).sent).toBe(1);
  expect(value.calls()).toBe(1); expect(sends).toBe(1);
});

test.each([
  ['body', 'ai'], ['body', 'privacy'], ['body', 'disabled'], ['body', 'lease'],
  ['claim', 'ai'], ['claim', 'privacy'], ['claim', 'disabled'], ['claim', 'lease'],
  ['quota', 'ai'], ['quota', 'privacy'], ['quota', 'disabled'], ['quota', 'lease'],
  ['quota', 'blocked'], ['quota', 'quarantined']
])('rechecks Telegram AI authorization after %s awaits when %s changes', async (stage, change) => {
  const value = aiFixture();
  let clock = dispatchTime;
  let changed = false;
  let providerCalls = 0;
  const prepare = value.DB.prepare.bind(value.DB);
  const target = stage === 'body' ? 'SELECT text_body, html_body, body_object_id'
    : stage === 'claim' ? 'INSERT INTO mail_ai_analyses' : 'INSERT INTO mail_ai_rate_limits';
  value.DB.prepare = (sql: string) => {
    const statement = prepare(sql);
    if (sql.includes(target)) {
      const first = statement.first.bind(statement);
      statement.first = async <T>() => {
        const row = await first<T>();
        const delivery = value.db.query('SELECT ai_attempted FROM workspace_telegram_deliveries').get() as { ai_attempted: number };
        if (delivery.ai_attempted === 1 && !changed) {
          if (change === 'lease') clock += 46_000;
          else value.db.exec({
            ai: 'UPDATE workspace_telegram_bindings SET ai_summary_enabled = 0',
            privacy: 'UPDATE workspace_telegram_bindings SET privacy_mode = 1',
            disabled: 'UPDATE workspace_telegram_bindings SET enabled = 0',
            blocked: "INSERT INTO blocked_senders VALUES ('user-1', 'sender@example.test', 'now')",
            quarantined: "INSERT INTO workspace_email_states (id,user_id,email_message_id,quarantined_at) VALUES ('state','user-1','email-1','now')"
          }[change]!);
          changed = true;
        }
        return row;
      };
    }
    return statement;
  };
  const texts: string[] = [];
  await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, {
    limit: 1, now: () => clock,
    aiProvider: { analyze: async (input) => { providerCalls++; return value.provider.analyze(input); } },
    fetchImpl: async (_input, init) => { texts.push(String(JSON.parse(String(init?.body)).text)); return telegramSuccess(); }
  });
  expect(changed).toBe(true); expect(providerCalls).toBe(0);
  if (change === 'lease' || change === 'disabled') expect(texts).toHaveLength(0);
  else if (change === 'privacy') expect(texts).toEqual(['FlareMail：收到一封新邮件。']);
  else { expect(texts).toHaveLength(1); expect(texts[0]).toContain('摘要：A bounded summary.'); expect(texts[0]).not.toContain('AI 摘要'); }
});

test('AI latency cannot spend Telegram send reservations early and cause back-to-back delivery', async () => {
  const value = aiFixture();
  value.db.exec(`INSERT INTO email_messages (id, owner_user_id, "from", "to", subject, timestamp, snippet, raw_key, recipient_status)
      VALUES ('email-2', 'user-1', 'sender@example.test', 'owner@example.test', 'Second', 'now', 'Second', '', 'managed');
    INSERT INTO workspace_telegram_deliveries
      (id, owner_user_id, email_message_id, binding_id, authorization_version, summary_enabled, status, next_attempt_at, created_at, updated_at)
      VALUES ('delivery-2', 'user-1', 'email-2', 'binding-1', 1, 1, 'pending', '2026-09-09T11:00:01.000Z', 'now', 'now');`);
  let clock = dispatchTime;
  const sends: number[] = [];
  const result = await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, {
    limit: 2, now: () => clock,
    aiProvider: { analyze: async (input) => { const analysis = await value.provider.analyze(input); clock += 2_000; return analysis; } },
    fetchImpl: async () => { sends.push(clock); return telegramSuccess(); }
  });
  expect(result).toMatchObject({ processed: 2, sent: 1, retryable: 1 });
  expect(sends).toEqual([dispatchTime + 2_000]);
  expect(value.db.query("SELECT status, last_error_code, next_attempt_at FROM workspace_telegram_deliveries WHERE id = 'delivery-2'").get())
    .toEqual({ status: 'retryable', last_error_code: 'local_rate_limited', next_attempt_at: new Date(dispatchTime + 7_000).toISOString() });
});

test('Telegram rate-limit cooldown starts at the fresh response time after AI and transport latency', async () => {
  const value = aiFixture();
  let clock = dispatchTime;
  await dispatchTelegramOutbox(value.env as unknown as CloudflareEnv, {
    limit: 1, now: () => clock,
    aiProvider: { analyze: async (input) => { const analysis = await value.provider.analyze(input); clock += 2_000; return analysis; } },
    fetchImpl: async () => {
      clock += 5_000;
      return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 1 } }), { status: 429 });
    }
  });
  const row = value.db.query('SELECT next_attempt_at FROM workspace_telegram_deliveries').get() as { next_attempt_at: string };
  expect(Date.parse(row.next_attempt_at)).toBeGreaterThanOrEqual(clock + 1_000);
});
