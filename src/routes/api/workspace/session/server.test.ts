import { describe, expect, test } from 'bun:test';
import { DELETE } from './+server';

describe('workspace session logout', () => {
  test('does not claim success when D1 revocation fails and still expires cookies', async () => {
    const deleted: string[] = [];
    const response = await DELETE({
      request: new Request('https://mail.example.test/api/workspace/session', { method: 'DELETE' }),
      url: new URL('https://mail.example.test/api/workspace/session'),
      platform: { env: { DB: { prepare: () => { throw new Error('D1 unavailable'); } } } },
      locals: { workspaceSessionToken: 'session-token' },
      cookies: { delete: (name: string) => { deleted.push(name); } }
    } as never);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'SESSION_REVOCATION_UNAVAILABLE' } });
    expect(deleted).toEqual(['__Host-flaremail_session', 'flaremail_session', 'flaremail_workspace']);
  });
});
