import { afterEach, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { readMailAiSettings, resolveWorkspaceMailAiConfiguration, saveMailAiSettings } from './settings';
import { GET, PATCH } from '../../../routes/api/workspace/ai/settings/+server';
import type { WorkspaceContext } from '$lib/server/workspace/shared';

class Statement {
  values: SQLQueryBindings[] = [];
  constructor(private db: Database, private sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this; }
  async first<T>() { return this.db.query(this.sql).get(...this.values) as T | null; }
}
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() {
  const sqlite = new Database(':memory:'); databases.push(sqlite);
  sqlite.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
  sqlite.exec(`INSERT INTO workspace_users (id,login_email,name,role,email,company,location,timezone,forwarding_enabled,signature,incoming_sequence)
    VALUES ('owner','owner@example.test','Owner','Owner','owner@example.test','','','UTC',0,'',0), ('other','other@example.test','Other','Owner','other@example.test','','','UTC',0,'',0);
    INSERT INTO workspace_owner (singleton,user_id) VALUES (1,'owner');
    INSERT INTO workspace_settings (user_id,theme,settings_json,created_at,updated_at) VALUES ('owner','dark','{"unrelated":{"keep":true}}','now','now');`);
  const env = { DB: { prepare: (sql: string) => new Statement(sqlite, sql) }, AI_SETTINGS_KEY: 'a'.repeat(64) } as unknown as CloudflareEnv;
  const input = { enabled: true, baseUrl: 'https://vendor.com/v1', model: 'test-model', apiFormat: 'responses', timeoutMs: 15000, maxInputChars: 16000, apiKey: 'provider-secret', revision: '' };
  const save = (extra: object = {}) => saveMailAiSettings(env, 'owner', { ...input, ...extra });
  const raw = () => JSON.parse((sqlite.query("SELECT settings_json FROM workspace_settings WHERE user_id='owner'").get() as { settings_json: string }).settings_json);
  return { sqlite, env, input, save, raw };
}
function event(env: CloudflareEnv, userId: string | null, body?: unknown) {
  const session: WorkspaceContext = { id: 'session', userId: userId ?? '', storage: 'd1', incomingSequence: 0, createdAt: '', updatedAt: '', profile: { name: '', role: '', email: '', company: '', location: '', timezone: '', forwardingEnabled: false, signature: '' } };
  const url = new URL('https://mail.test/api/workspace/ai/settings');
  return { url, platform: { env }, locals: { workspaceSession: userId ? session : null }, request: new Request(url, body === undefined ? {} : { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) } as never;
}

describe('encrypted Owner AI settings', () => {
  test('defaults and environment fallback never expose keys', async () => {
    const f = setup();
    Object.assign(f.env, { AI_ENABLED: 'true', AI_BASE_URL: f.input.baseUrl, AI_MODEL: 'env-model', AI_API_KEY: 'env-secret' });
    const view = await readMailAiSettings(f.env, 'owner');
    expect(view).toMatchObject({ source: 'server', hasApiKey: true, canSave: true, revision: '', settings: { model: 'env-model', apiFormat: 'chat-completions', summaryLanguage: 'auto', backgroundLanguage: 'zh-CN' } });
    expect(JSON.stringify(view)).not.toContain('env-secret');
    expect((await resolveWorkspaceMailAiConfiguration(f.env, 'owner')).config?.apiKey).toBe('env-secret');
  });
  test('encrypts at rest, immediately applies settings, preserves other settings and only returns public fields', async () => {
    const f = setup(); const view = await f.save();
    expect(view).toMatchObject({ source: 'workspace', hasApiKey: true, settings: { model: 'test-model', apiFormat: 'responses' } });
    expect(JSON.stringify(view)).not.toContain('provider-secret'); expect(JSON.stringify(view)).not.toContain('encryptedKey');
    const raw = f.raw(); expect(raw.unrelated.keep).toBe(true); expect(raw.mailAi.encryptedKey).toStartWith('v1.');
    expect(JSON.stringify(raw)).not.toContain('provider-secret');
    expect((await resolveWorkspaceMailAiConfiguration(f.env, 'owner')).config).toMatchObject({ apiKey: 'provider-secret', apiFormat: 'responses', model: 'test-model' });
    expect((f.sqlite.query("SELECT theme FROM workspace_settings WHERE user_id='owner'").get() as {theme:string}).theme).toBe('dark');
  });
  test('full endpoint settings keep their encrypted key binding on reads and later edits', async () => {
    const f = setup(); const baseUrl = f.input.baseUrl + '/responses';
    const saved = await f.save({ baseUrl });
    expect((await readMailAiSettings(f.env, 'owner')).settings.baseUrl).toBe(baseUrl);
    expect((await resolveWorkspaceMailAiConfiguration(f.env, 'owner')).config).toMatchObject({ baseUrl, apiKey: 'provider-secret' });
    await f.save({ baseUrl, apiKey: '', model: 'changed-model', revision: saved.revision });
    expect((await resolveWorkspaceMailAiConfiguration(f.env, 'owner')).config).toMatchObject({ baseUrl, apiKey: 'provider-secret', model: 'changed-model' });
  });
  test('blank input retains the key; explicit delete clears it without environment fallback', async () => {
    const f = setup(); const view = await f.save();
    const updated = await f.save({ apiKey: '', model: 'changed', revision: view.revision });
    expect((await resolveWorkspaceMailAiConfiguration(f.env, 'owner')).config?.apiKey).toBe('provider-secret');
    f.env.AI_API_KEY = 'must-not-fall-back';
    const removed = await f.save({ enabled: false, apiKey: '', clearApiKey: true, revision: updated.revision });
    expect(removed.hasApiKey).toBe(false); expect(f.raw().mailAi.encryptedKey).toBeNull();
    expect((await resolveWorkspaceMailAiConfiguration(f.env, 'owner')).status).toBe('disabled');
  });
  test('endpoint changes require key reentry and invalid settings are rejected without writes', async () => {
    const f = setup(); const v = await f.save();
    await expect(f.save({ apiKey: '', baseUrl: 'https://other.com/v1', revision: v.revision })).rejects.toMatchObject({ code: 'AI_KEY_REENTRY_REQUIRED' });
    for (const extra of [{ baseUrl: 'http://vendor.com/v1' }, { baseUrl: 'https://127.0.0.1' }, { apiFormat: 'unknown' }, { enabled: 'true' }, { timeoutMs: 30001 }, { maxInputChars: 1 }, { apiKey: 'bad\nkey' }, { clearApiKey: 'yes' }, { extraField: true }]) {
      await expect(f.save({ ...extra, revision: v.revision })).rejects.toMatchObject({ status: 400 });
    }
    expect((await readMailAiSettings(f.env, 'owner')).revision).toBe(v.revision);
  });
  test('canonical language preferences persist and old clients preserve them', async () => {
    const f = setup();
    const saved = await f.save({ summaryLanguage: 'ZH-tw', backgroundLanguage: 'en' });
    expect(saved.settings).toMatchObject({ summaryLanguage: 'zh-TW', backgroundLanguage: 'en' });
    const updated = await f.save({ apiKey: '', revision: saved.revision });
    expect(updated.settings).toMatchObject({ summaryLanguage: 'zh-TW', backgroundLanguage: 'en' });
    expect(await resolveWorkspaceMailAiConfiguration(f.env, 'owner')).toMatchObject({ summaryLanguage: 'zh-TW', backgroundLanguage: 'en' });
    f.sqlite.exec("UPDATE workspace_settings SET settings_json=json_remove(settings_json,'$.mailAi.summaryLanguage','$.mailAi.backgroundLanguage') WHERE user_id='owner'");
    expect((await readMailAiSettings(f.env, 'owner')).settings).toMatchObject({ summaryLanguage: 'auto', backgroundLanguage: 'zh-CN' });
    expect((await resolveWorkspaceMailAiConfiguration(f.env, 'owner')).config?.apiKey).toBe('provider-secret');
    const legacySave = await f.save({ apiKey: '', revision: updated.revision });
    expect(legacySave.settings).toMatchObject({ summaryLanguage: 'auto', backgroundLanguage: 'zh-CN' });
    const languageOnly = await f.save({ apiKey: '', summaryLanguage: 'ja', revision: legacySave.revision });
    expect(languageOnly.settings).toMatchObject({ summaryLanguage: 'ja', backgroundLanguage: 'zh-CN' });
    const backgroundOnly = await f.save({ apiKey: '', backgroundLanguage: 'en', revision: languageOnly.revision });
    expect(backgroundOnly.settings).toMatchObject({ summaryLanguage: 'ja', backgroundLanguage: 'en' });
  });
  test('invalid language settings never change saved preferences', async () => {
    const f = setup(); const saved = await f.save({ summaryLanguage: 'ja', backgroundLanguage: 'en' });
    for (const extra of [
      ...['', 'en_US', 'Respond in Japanese', 'en\n', 'x'.repeat(65), 'en--US', null, 1, ['en']].map((summaryLanguage) => ({ summaryLanguage })),
      ...['ja', '', null, 1].map((backgroundLanguage) => ({ backgroundLanguage }))
    ]) await expect(f.save({ ...extra, revision: saved.revision })).rejects.toMatchObject({ code: 'AI_INVALID_SETTINGS' });
    expect((await readMailAiSettings(f.env, 'owner')).settings).toMatchObject({ summaryLanguage: 'ja', backgroundLanguage: 'en' });
    expect((await readMailAiSettings(f.env, 'owner')).revision).toBe(saved.revision);
  });
  test('malformed persisted language fails closed instead of falling back to environment AI', async () => {
    for (const changed of [{ summaryLanguage: null }, { summaryLanguage: 'en_US' }, { backgroundLanguage: 'ja' }]) {
      const f = setup(); await f.save();
      const saved = f.raw(); Object.assign(saved.mailAi, changed);
      f.sqlite.query("UPDATE workspace_settings SET settings_json = ? WHERE user_id='owner'").run(JSON.stringify(saved));
      await expect(readMailAiSettings(f.env, 'owner')).rejects.toMatchObject({ code: 'AI_SETTINGS_INVALID' });
      await expect(resolveWorkspaceMailAiConfiguration(f.env, 'owner')).rejects.toMatchObject({ code: 'AI_SETTINGS_INVALID' });
    }
  });
  test('fences concurrent saves and keeps the winning key', async () => {
    const f = setup(); const v = await f.save();
    const result = await Promise.allSettled([f.save({ apiKey: 'winner-or-loser-a', revision: v.revision }), f.save({ apiKey: 'winner-or-loser-b', revision: v.revision })]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winner = (await resolveWorkspaceMailAiConfiguration(f.env, 'owner')).config;
    expect(winner).not.toBeNull();
    expect(['winner-or-loser-a', 'winner-or-loser-b']).toContain(winner!.apiKey);
  });
  test('binds ciphertext to Owner and endpoint, and allows recovery by replacing the key', async () => {
    const f = setup(); const v = await f.save();
    f.sqlite.query("INSERT INTO workspace_settings (user_id,theme,settings_json,created_at,updated_at) VALUES ('other','system',?,'now','now')").run(JSON.stringify(f.raw()));
    await expect(resolveWorkspaceMailAiConfiguration(f.env, 'other')).rejects.toMatchObject({ code: 'AI_SETTINGS_KEY_UNAVAILABLE' });
    f.sqlite.exec("UPDATE workspace_settings SET settings_json=json_set(settings_json,'$.mailAi.baseUrl','https://other.com/v1') WHERE user_id='owner'");
    await expect(resolveWorkspaceMailAiConfiguration(f.env, 'owner')).rejects.toMatchObject({ code: 'AI_SETTINGS_KEY_UNAVAILABLE' });
    await f.save({ baseUrl: 'https://other.com/v1', apiKey: 'replacement', revision: v.revision });
    expect((await resolveWorkspaceMailAiConfiguration(f.env, 'owner')).config?.apiKey).toBe('replacement');
  });
  test('missing master key fails closed; changed master key can be recovered with a replacement provider key', async () => {
    const f = setup(); delete f.env.AI_SETTINGS_KEY;
    expect((await readMailAiSettings(f.env, 'owner')).canSave).toBe(false);
    await expect(f.save()).rejects.toMatchObject({ code: 'AI_SETTINGS_KEY_UNAVAILABLE' });
    f.env.AI_SETTINGS_KEY = 'a'.repeat(64); const v = await f.save(); f.env.AI_SETTINGS_KEY = 'b'.repeat(64);
    await expect(resolveWorkspaceMailAiConfiguration(f.env, 'owner')).rejects.toMatchObject({ code: 'AI_SETTINGS_KEY_UNAVAILABLE' });
    await f.save({ revision: v.revision, apiKey: 'replacement' });
    expect((await resolveWorkspaceMailAiConfiguration(f.env, 'owner')).config?.apiKey).toBe('replacement');
  });
  test('API requires authentication and singleton Owner, uses no-store and never returns the submitted key', async () => {
    const f = setup();
    expect((await GET(event(f.env, null))).status).toBe(401);
    expect((await GET(event(f.env, 'other'))).status).toBe(403);
    expect((await PATCH(event(f.env, 'other', f.input))).status).toBe(403);
    const saved = await PATCH(event(f.env, 'owner', f.input)); expect(saved.status).toBe(200);
    expect(JSON.stringify(await saved.json())).not.toContain('provider-secret');
    const read = await GET(event(f.env, 'owner')); expect(read.headers.get('cache-control')).toContain('no-store');
    expect(JSON.stringify(await read.json())).not.toContain('provider-secret');
    expect((await PATCH(event(f.env, 'owner', { ...f.input, apiKey: 'x'.repeat(13000) }))).status).toBe(413);
  });
});
