import { afterEach, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { insertMailAiJobIfEligible, claimMailAiJob, reserveMailAiJobAttempt } from '$lib/server/db/mail-ai-jobs';
import { resolveInboxCategory } from '$lib/domain/mail';
import { workspaceMailAi } from '$lib/server/workspace/ai';
import { mapUserRowToProfile, type WorkspaceContext, type WorkspaceUserRow } from '$lib/server/workspace/shared';
import { readMailAiSettings, saveMailAiSettings } from './settings';
import { dispatchMailAiJobs } from './dispatcher';
import type { MailAiProvider } from './provider';
import { ApiError } from '$lib/server/http/api';

class Statement {
  values: SQLQueryBindings[] = [];
  constructor(private db: Database, private sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this; }
  async first<T>() { return this.db.query(this.sql).get(...this.values) as T | null; }
  async run() { return { meta: { changes: Number(this.db.query(this.sql).run(...this.values).changes) } }; }
}
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
async function fixture() {
  const sqlite = new Database(':memory:'); databases.push(sqlite);
  sqlite.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
  sqlite.exec(`INSERT INTO workspace_users (id,login_email,name,role,email) VALUES ('owner','owner@example.test','Owner','Owner','owner@example.test');
    INSERT INTO workspace_owner (singleton,user_id) VALUES (1,'owner');
    INSERT INTO email_messages (id,owner_user_id,"from","to",subject,timestamp,raw_key,text_body)
      VALUES ('mail','owner','sender@example.test','owner@example.test','Invoice','now','raw/mail','Please pay invoice 123.');`);
  const env = { DB: { prepare: (sql: string) => new Statement(sqlite, sql) }, AI_SETTINGS_KEY: 'a'.repeat(64) } as unknown as CloudflareEnv;
  const save = async (extra: object = {}) => {
    const current = await readMailAiSettings(env, 'owner');
    return saveMailAiSettings(env, 'owner', { ...current.settings, enabled: true, baseUrl: 'https://vendor.com/v1', model: 'fake',
      apiFormat: 'chat-completions', apiKey: 'fake-key', revision: current.revision, ...extra });
  };
  const enqueue = () => insertMailAiJobIfEligible(env.DB, 'owner', 'mail').run();
  let calls = 0;
  const provider: MailAiProvider = { analyze: async (input) => {
    calls++;
    return { summary: 'Invoice summary', keyPoints: [], actionItems: [], dates: [], language: input.language,
      suggestion: { category: 'transactions', confidence: 0.9, reason: 'Invoice' } };
  } };
  const session: WorkspaceContext = { id: '', userId: 'owner', storage: 'd1', incomingSequence: 0, createdAt: '', updatedAt: '',
    profile: mapUserRowToProfile(sqlite.query('SELECT * FROM workspace_users').get() as WorkspaceUserRow) };
  const job = () => sqlite.query('SELECT * FROM mail_ai_jobs').get() as { status: string; attempted: number; next_attempt_at: number };
  return { sqlite, env, save, enqueue, provider, session, job, calls: () => calls };
}

test('classification is opt-in, never backfills, and generates shared web cache without Telegram', async () => {
  const f = await fixture();
  await f.save(); await f.enqueue(); expect(f.job()).toBeNull();
  await f.save({ automaticClassification: true });
  expect((await dispatchMailAiJobs(f.env, { provider: f.provider })).processed).toBe(0);
  await f.enqueue();
  expect(await dispatchMailAiJobs(f.env, { provider: f.provider })).toEqual({ processed: 1, classified: 1 });
  expect(f.job()).toMatchObject({ status: 'done', attempted: 1 });
  expect(f.sqlite.query('SELECT inbox_category_v2, ai_inbox_category FROM email_messages').get())
    .toEqual({ inbox_category_v2: null, ai_inbox_category: 'transactions' });
  expect(await workspaceMailAi(f.env, f.session, 'email:mail', { language: 'en' }, f.provider))
    .toMatchObject({ status: 'ready', analysis: { summary: 'Invoice summary' }, language: 'zh-CN' });
  expect(f.calls()).toBe(1);
});

test('a completed Telegram-style background analysis is reused without spending another request', async () => {
  const f = await fixture(); await f.save({ automaticClassification: true }); await f.enqueue();
  await workspaceMailAi(f.env, f.session, 'email:mail', { analyze: true, beforeAnalyze: async () => true }, f.provider);
  expect((await dispatchMailAiJobs(f.env, { provider: f.provider })).classified).toBe(1);
  expect(f.job()).toMatchObject({ status: 'done', attempted: 0 }); expect(f.calls()).toBe(1);
});

test.each(['background', 'explicit'] as const)('a delayed %s category write cannot overwrite a newer regenerated result', async (caller) => {
  const f = await fixture(); await f.save({ automaticClassification: true }); await f.enqueue();
  await workspaceMailAi(f.env, f.session, 'email:mail', { analyze: true, beforeAnalyze: async () => true }, f.provider);
  f.sqlite.exec('UPDATE mail_ai_analyses SET updated_at=0');
  let entered!: () => void; let release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  let pause = true;
  f.env.DB.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith('UPDATE email_messages SET ai_inbox_category')) {
      const run = statement.run.bind(statement);
      statement.run = (async () => { if (pause) { pause = false; entered(); await blocked; } return run(); }) as typeof statement.run;
    }
    return statement;
  }) as typeof f.env.DB.prepare;
  const older = caller === 'background' ? dispatchMailAiJobs(f.env, { provider: f.provider })
    : workspaceMailAi(f.env, f.session, 'email:mail', { analyze: true }, f.provider);
  await waiting;
  const newer: MailAiProvider = { analyze: async (input) => ({ ...await f.provider.analyze(input),
    suggestion: { category: 'security', confidence: 0.9, reason: 'Account security' } }) };
  await workspaceMailAi(f.env, f.session, 'email:mail', { analyze: true, regenerate: true }, newer);
  release(); await older;
  expect(f.sqlite.query('SELECT ai_inbox_category FROM email_messages').get()).toEqual({ ai_inbox_category: 'security' });
  if (caller === 'background') {
    expect(f.job()).toMatchObject({ status: 'pending', attempted: 0 });
    f.sqlite.exec('UPDATE mail_ai_jobs SET next_attempt_at=0');
    expect((await dispatchMailAiJobs(f.env, { provider: f.provider })).classified).toBe(1);
    expect(f.job().status).toBe('done');
  }
  expect((await workspaceMailAi(f.env, f.session, 'email:mail', {})).analysis?.suggestion?.category).toBe('security');
  expect(f.calls()).toBe(2);
});

test.each(['disabled', 'reenabled', 'manual', 'quarantined', 'blocked'] as const)('queued work respects %s before any provider call', async (change) => {
  const f = await fixture(); await f.save({ automaticClassification: true }); await f.enqueue();
  if (change === 'disabled' || change === 'reenabled') await f.save({ automaticClassification: false });
  if (change === 'reenabled') await f.save({ automaticClassification: true });
  if (change === 'manual') f.sqlite.exec("UPDATE email_messages SET inbox_category_v2='primary'");
  if (change === 'quarantined') f.sqlite.exec("INSERT INTO workspace_email_states (id,user_id,email_message_id,quarantined_at) VALUES ('state','owner','mail','now')");
  if (change === 'blocked') f.sqlite.exec("INSERT INTO blocked_senders VALUES ('owner','sender@example.test','now')");
  await dispatchMailAiJobs(f.env, { provider: f.provider });
  expect(f.calls()).toBe(0); expect(f.job().status).toBe('cancelled');
});

test.each(['manual', 'revoked'] as const)('a concurrent %s decision wins while the model is running', async (change) => {
  const f = await fixture(); await f.save({ automaticClassification: true }); await f.enqueue();
  const provider: MailAiProvider = { analyze: async (input) => {
    const result = await f.provider.analyze(input);
    if (change === 'manual') f.sqlite.exec("UPDATE email_messages SET inbox_category_v2='security'");
    else await f.save({ automaticClassification: false });
    return result;
  } };
  expect((await dispatchMailAiJobs(f.env, { provider })).classified).toBe(0);
  expect(f.sqlite.query('SELECT ai_inbox_category FROM email_messages').get()).toEqual({ ai_inbox_category: null });
});

test('failed background generation and expired attempted leases never start another billable request', async () => {
  const f = await fixture(); await f.save({ automaticClassification: true }); await f.enqueue();
  let calls = 0;
  const provider = { analyze: async () => { calls++; throw new Error('synthetic provider failure'); } };
  await dispatchMailAiJobs(f.env, { provider });
  expect(f.job()).toMatchObject({ status: 'failed', attempted: 1 });
  f.sqlite.exec("UPDATE mail_ai_jobs SET status='processing', lease_until=0");
  await dispatchMailAiJobs(f.env, { provider });
  expect(f.job().status).toBe('failed'); expect(calls).toBe(1);
});

test('quota exhaustion defers unattempted work; concurrent dispatchers share a single analysis', async () => {
  const f = await fixture(); await f.save({ automaticClassification: true }); await f.enqueue();
  f.sqlite.query('INSERT INTO mail_ai_rate_limits VALUES (?,30,?)').run('owner', Date.now() + 3_600_000);
  await dispatchMailAiJobs(f.env, { provider: f.provider });
  expect(f.job()).toMatchObject({ status: 'pending', attempted: 0 }); expect(f.calls()).toBe(0);
  f.sqlite.exec('DELETE FROM mail_ai_rate_limits; UPDATE mail_ai_jobs SET next_attempt_at=0; UPDATE mail_ai_analyses SET updated_at=0');
  await Promise.all([dispatchMailAiJobs(f.env, { provider: f.provider }), dispatchMailAiJobs(f.env, { provider: f.provider })]);
  expect(f.calls()).toBe(1); expect(f.job().status).toBe('done');
});

test('budget exhaustion during reservation defers without consuming the generation attempt', async () => {
  const f = await fixture(); await f.save({ automaticClassification: true }); await f.enqueue();
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith('UPDATE mail_ai_jobs SET attempted = 1')) {
      const first = statement.first.bind(statement);
      statement.first = (async () => { const row = await first(); await Bun.sleep(300); return row; }) as typeof statement.first;
    }
    return statement;
  }) as typeof f.env.DB.prepare;
  await dispatchMailAiJobs(f.env, { provider: f.provider, timeBudgetMs: 250 });
  expect(f.calls()).toBe(0);
  expect(f.job()).toMatchObject({ status: 'pending', attempted: 0 });
  expect(f.job().next_attempt_at).toBeGreaterThan(Date.now());
  f.env.DB.prepare = prepare;
  f.sqlite.exec('UPDATE mail_ai_jobs SET next_attempt_at=0; UPDATE mail_ai_analyses SET updated_at=0');
  expect((await dispatchMailAiJobs(f.env, { provider: f.provider })).classified).toBe(1);
  expect(f.calls()).toBe(1); expect(f.job()).toMatchObject({ status: 'done', attempted: 1 });
});

test('a timeout after invoking the provider remains attempted and is never automatically retried', async () => {
  const f = await fixture(); await f.save({ automaticClassification: true }); await f.enqueue();
  let calls = 0;
  const provider: MailAiProvider = { analyze: async () => { calls++; throw new ApiError(503, 'AI_TIMEOUT', 'AI analysis timed out.'); } };
  await dispatchMailAiJobs(f.env, { provider });
  await dispatchMailAiJobs(f.env, { provider });
  expect(calls).toBe(1); expect(f.job()).toMatchObject({ status: 'failed', attempted: 1 });
});

test('last-moment revocation prevents reserving the billable attempt and deletion cleans up work', async () => {
  const f = await fixture(); await f.save({ automaticClassification: true }); await f.enqueue();
  const job = (await claimMailAiJob(f.env.DB))!;
  await f.save({ automaticClassification: false });
  expect(await reserveMailAiJobAttempt(f.env.DB, job)).toBe(false);
  f.sqlite.exec("DELETE FROM email_messages WHERE id='mail'"); expect(f.job()).toBeNull();
});

test('explicit historical regeneration can update AI classification while reads remain side-effect free', async () => {
  const f = await fixture(); await f.save({ automaticClassification: true });
  const result = await workspaceMailAi(f.env, f.session, 'email:mail', { analyze: true }, f.provider);
  expect(result.appliedCategory).toBe('transactions');
  f.sqlite.exec("UPDATE email_messages SET inbox_category_v2='primary'");
  const cached = await workspaceMailAi(f.env, f.session, 'email:mail', {}, f.provider);
  expect(cached.appliedCategory).toBeUndefined();
  expect(resolveInboxCategory('sender@example.test', 'Invoice', 'primary', 'transactions')).toBe('primary');
  expect(f.calls()).toBe(1);
});
