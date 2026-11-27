import { expect, test } from 'bun:test';
import { openMcpTestDatabase } from '$lib/server/mcp/d1.test-fixture';
import { GET, POST } from './+server';

test('keeps Integrations available to the Owner during the schema-42 rollout window', async () => {
  using fixture = openMcpTestDatabase();
  fixture.database.exec(`
    DROP TABLE mcp_activity;
    DROP TABLE mcp_credentials;
    DROP TABLE mcp_grants;
    DROP TABLE mcp_consent_nonces;
    DROP TABLE mcp_policies;
    UPDATE workspace_schema_metadata SET schema_version = 42 WHERE schema_name = 'flaremail';
  `);
  const url = new URL('https://flaremail.test/api/workspace/integrations/mcp');
  function event(method: 'GET' | 'POST', userId = 'owner') {
    return {
      url, platform: { env: { DB: fixture.db } },
      locals: { workspaceSession: { userId, storage: 'd1' } },
      request: new Request(url, { method, ...(method === 'POST' ? {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'settings', enabled: true, scopes: ['mail.read'] })
      } : {}) })
    } as never;
  }
  const settings = await GET(event('GET'));
  expect(settings.status).toBe(200);
  expect(await settings.json()).toMatchObject({ data: { status: 'unavailable', enabled: false, clients: [] } });
  expect((await POST(event('POST'))).status).toBe(503);
  expect((await GET(event('GET', 'other'))).status).toBe(403);
});
