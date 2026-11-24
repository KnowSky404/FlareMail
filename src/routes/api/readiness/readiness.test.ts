import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { FLAREMAIL_SCHEMA_VERSION } from '$lib/server/db/schema-version';
import { GET } from './+server';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly db: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async all<T>() { return { results: this.db.query(this.sql).all(...this.values) as T[] }; }
  async first<T>() { return (this.db.query(this.sql).get(...this.values) as T | null) ?? null; }
}

class D1 {
  constructor(readonly db: Database) {}
  prepare(sql: string) { return new Statement(this.db, sql) as unknown as D1PreparedStatement; }
}

const event = (env: unknown, requestId = 'readiness-test', authenticated = true, query = '') => ({
  url: new URL('https://mail.example.test/api/readiness' + query),
  platform: { env },
  request: new Request('https://mail.example.test/api/readiness', { headers: { 'X-Request-ID': requestId } }),
  locals: authenticated ? {
    workspaceSession: {
      id: 'session-1', userId: 'owner-1', profile: {}, incomingSequence: 0,
      createdAt: '', updatedAt: '', storage: 'd1'
    }
  } : {}
}) as never;
const repositoryRoot = resolve(import.meta.dir, '../../../..');
const migrationsDirectory = join(repositoryRoot, 'migrations');

function applyMigrations(database: Database) {
  for (const file of readdirSync(migrationsDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    database.exec(readFileSync(join(migrationsDirectory, file), 'utf8'));
  }
}

async function health(database: Database, configuration: Record<string, unknown> = {}) {
  return GET(event({ APP_ENV: 'test', DB: new D1(database), BUCKET: {}, ...configuration }));
}

describe('/api/readiness', () => {
  test('requires an authenticated workspace before exposing readiness details', async () => {
    const response = await GET(event({ APP_ENV: 'test' }, 'readiness-private', false));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(expect.objectContaining({
      ok: false,
      requestId: 'readiness-private',
      error: expect.objectContaining({ code: 'AUTHENTICATION_REQUIRED' })
    }));
  });

  test('system scope checks R2 without fetching domain health and clears degradation after a successful probe', async () => {
    const database = new Database(':memory:');
    applyMigrations(database);
    let calls = 0;
    const env = { APP_ENV: 'test', DB: new D1(database), BUCKET: {
      async head() {
        if (++calls === 1) throw new Error('synthetic bucket unavailable');
        return null;
      }
    } };
    const probe = () => GET(event(env, 'system-readiness', true, '?scope=system'));
    const offline = await probe();
    expect(offline.status).toBe(503);
    expect(await offline.json()).toMatchObject({ error: { code: 'R2_UNAVAILABLE' } });
    const recovered = await probe();
    expect(recovered.status).toBe(200);
    const body = await recovered.json();
    expect(body).toMatchObject({ ok: true });
    expect(body).not.toHaveProperty('mailHealth');
    expect(body).not.toHaveProperty('cleanupQueue');
    const missingProviderKey = await GET(event({ ...env, OUTBOUND_PROVIDER: 'resend' }, 'system-configuration', true, '?scope=system'));
    expect(missingProviderKey.status).toBe(503);
    expect(await missingProviderKey.json()).toMatchObject({ error: { code: 'CONFIG_INVALID' } });
    expect(calls).toBe(2);
    database.close();
  });

  test('reports a missing production webhook secret through authenticated system readiness', async () => {
    using database = new Database(':memory:');
    applyMigrations(database);
    const env = {
      APP_ENV: 'production', OUTBOUND_PROVIDER: 'resend', RESEND_API_KEY: 'synthetic-key',
      DB: new D1(database), BUCKET: { async head() { return null; } }
    };
    const missing = await GET(event(env, 'system-production', true, '?scope=system'));
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ error: { code: 'CONFIG_INVALID' } });
    const secret = `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`;
    const noProvider = await GET(event({ ...env, OUTBOUND_PROVIDER: undefined, RESEND_WEBHOOK_SECRET: secret }, 'system-production', true, '?scope=system'));
    expect(noProvider.status).toBe(503);
    expect(await noProvider.json()).toMatchObject({ error: { code: 'CONFIG_INVALID' } });
    expect((await GET(event({ ...env, RESEND_WEBHOOK_SECRET: secret }, 'system-production', true, '?scope=system'))).status).toBe(200);

    const preview = { ...env, APP_ENV: 'preview' };
    const previewMissing = await GET(event(preview, 'system-preview', true, '?scope=system'));
    expect(previewMissing.status).toBe(503);
    expect(await previewMissing.json()).toMatchObject({ error: { code: 'CONFIG_INVALID' } });
    expect((await GET(event({ ...preview, RESEND_WEBHOOK_SECRET: secret }, 'system-preview', true, '?scope=system'))).status).toBe(200);
  });

  test('rejects an empty or partially migrated database', async () => {
    const empty = new Database(':memory:');
    expect((await GET(event({ APP_ENV: 'test', DB: new D1(empty) }))).status).toBe(503);
    const partial = new Database(':memory:');
    partial.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
    expect((await GET(event({ APP_ENV: 'test', DB: new D1(partial) }))).status).toBe(503);
  });

  test('accepts the schema produced by all ordered migrations', async () => {
    const database = new Database(':memory:');
    applyMigrations(database);
    const response = await health(database);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ ok: true, version: 'development' }));
    expect((database.query(`SELECT schema_version FROM workspace_schema_metadata WHERE schema_name = 'flaremail'`).get() as { schema_version: number }).schema_version)
      .toBe(FLAREMAIL_SCHEMA_VERSION);
  });

  test('checks the configured shared registry and reports the read-only preview scope', async () => {
    using database = new Database(':memory:');
    using registry = new Database(':memory:');
    using previewDatabase = new Database(':memory:');
    applyMigrations(database);
    const bindings = { INBOUND_ROUTING_SCOPE: { environment: 'preview', readOnly: true }, INBOUND_ROUTING_DB: new D1(registry) };
    const missing = await health(database, bindings);
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ error: { code: 'INBOUND_ROUTING_NOT_READY' } });
    registry.exec(readFileSync(join(repositoryRoot, 'routing-migrations/0001_ownership.sql'), 'utf8'));
    const ready = await health(database, bindings);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ inboundRouting: { environment: 'preview', readOnly: true } });
    const wrongProductionScope = await health(database, { ...bindings, APP_ENV: 'production' });
    expect(wrongProductionScope.status).toBe(503);
    expect(await wrongProductionScope.json()).toMatchObject({ error: { code: 'INBOUND_ROUTING_NOT_READY' } });
    const production = { ...bindings, INBOUND_ROUTING_SCOPE: { environment: 'production' }, PRE_INBOUND_DB: new D1(previewDatabase) };
    const malformed = await health(database, production);
    expect(malformed.status).toBe(503);
    expect(await malformed.json()).toMatchObject({ error: { code: 'INBOUND_ROUTING_NOT_READY' } });
    const productionBindings = {
      ...production, PRE_INBOUND_SETTINGS: { recipient: null, enabled: false }, PRE_INBOUND_BUCKET: { put() {} }
    };
    expect((await health(database, productionBindings)).status).toBe(200);
    const activePreview = { ...productionBindings, PRE_INBOUND_SETTINGS: { recipient: null, enabled: true } };
    const missingPreviewSchema = await health(database, activePreview);
    expect(missingPreviewSchema.status).toBe(503);
    expect(await missingPreviewSchema.json()).toMatchObject({ error: { code: 'INBOUND_ROUTING_NOT_READY' } });
    applyMigrations(previewDatabase);
    const productionReady = await health(database, activePreview);
    expect(productionReady.status).toBe(200);
    expect(await productionReady.json()).toMatchObject({ inboundRouting: { environment: 'production', readOnly: false } });
    const wrongPreviewScope = await health(database, { ...activePreview, APP_ENV: 'preview' });
    expect(wrongPreviewScope.status).toBe(503);
    expect(await wrongPreviewScope.json()).toMatchObject({ error: { code: 'INBOUND_ROUTING_NOT_READY' } });

    const settings = { recipient: 'pre@example.test', enabled: false };
    const preDb = new D1(previewDatabase);
    const fixedWithoutBucket = await health(database, { PRE_INBOUND_SETTINGS: settings, PRE_INBOUND_DB: preDb });
    expect(fixedWithoutBucket.status).toBe(503);
    const fixed = await health(database, { PRE_INBOUND_SETTINGS: settings, PRE_INBOUND_DB: preDb, PRE_INBOUND_BUCKET: { put() {} } });
    expect(fixed.status).toBe(200);
    expect((await health(database, { PRE_INBOUND_SETTINGS: { ...settings, previewApp: true } })).status).toBe(200);
  });

  test('exposes provider-specific health only through the authenticated readiness endpoint', async () => {
    const database = new Database(':memory:');
    applyMigrations(database);
    database.query(`
      INSERT INTO mail_domains (id, owner_user_id, domain_name, cloudflare_zone_id, worker_name,
        cloudflare_error_code, last_error_code, last_error_at)
      VALUES ('domain-1', 'owner-1', 'mail.example.test', ?, 'flaremail-worker',
        'cloudflare_managed_route_needs_review', 'preview_catch_all:cloudflare_timeout', '2026-09-21T12:00:00.000Z')
    `).run('a'.repeat(32));
    const response = await health(database, {
      CLOUDFLARE_EMAIL_ROUTING_TOKEN: 'private-cloudflare-token',
      RESEND_API_KEY: 'private-resend-key'
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { mailHealth: Array<Record<string, unknown>> };
    expect(payload.mailHealth[0]).toMatchObject({
      domainId: 'domain-1',
      domainName: 'mail.example.test',
      cloudflare: {
        state: 'degraded', checkedAt: null, catchAllCheckedAt: null, errorCode: 'cloudflare_managed_route_needs_review',
        catchAllRefreshError: { code: 'cloudflare_timeout', at: '2026-09-21T12:00:00.000Z' }
      },
      resend: { state: 'stale', checkedAt: null, errorCode: null, status: 'unknown' }
    });
    expect(JSON.stringify(payload)).not.toContain('private-cloudflare-token');
    expect(JSON.stringify(payload)).not.toContain('private-resend-key');
    const publicHealth = await (await import('../health/+server')).GET(event({}));
    expect(await publicHealth.json() as unknown).toEqual({ ok: true });
    database.close();
  });

  test.each([29, FLAREMAIL_SCHEMA_VERSION + 1])(
    'rejects schema version %i',
    async (schemaVersion) => {
      const database = new Database(':memory:');
      applyMigrations(database);
      database.query(`UPDATE workspace_schema_metadata SET schema_version = ? WHERE schema_name = 'flaremail'`).run(schemaVersion);
      expect((await health(database)).status).toBe(503);
    }
  );

  test('rejects missing metadata and missing required tables without leaking details', async () => {
    for (const statement of [
      'DELETE FROM workspace_schema_metadata',
      'DROP TABLE workspace_delivery_attempts',
      'DROP TABLE workspace_outbound_rate_limits'
    ]) {
      const database = new Database(':memory:');
      applyMigrations(database);
      database.exec(statement);
      const response = await health(database);
      expect(response.status).toBe(503);
      const body = await response.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['error', 'ok', 'requestId', 'timestamp', 'version']);
      expect(JSON.stringify(body).toLowerCase()).not.toContain('sqlite');
      database.close();
    }
  });

  test('returns 503 without D1 and does not expose schema details', async () => {
    const response = await GET(event({ APP_ENV: 'test' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(expect.objectContaining({
      ok: false,
      requestId: 'readiness-test',
      error: expect.objectContaining({ code: 'D1_UNAVAILABLE', retryable: true })
    }));
    expect(JSON.stringify(await GET(event({ APP_ENV: 'test' }))).toLowerCase()).not.toContain('sqlite');
  });

  test('returns a typed configuration failure without exposing configuration values', async () => {
    const response = await GET(event({ APP_ENV: 'production' }, 'config-failure'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(expect.objectContaining({
      ok: false,
      requestId: 'config-failure',
      error: expect.objectContaining({ code: 'CONFIG_INVALID', retryable: false })
    }));
  });
});
