import { describe, expect, test } from 'bun:test';
import { sendAutomaticReply } from './system';

const env = {
  APP_ENV: 'test', OUTBOUND_PROVIDER: 'fake', ALLOW_FAKE_SERVICES: 'true', AUTO_REPLY_ENABLED: 'true',
  OUTBOUND_FROM_EMAIL: 'mail@example.test', AUTO_REPLY_TEXT: 'Thanks'
} as unknown as CloudflareEnv;

function inbound(from: string, headers: Record<string, string> = {}) {
  return { from, to: 'mail@example.test', headers: new Headers(headers) } as unknown as ForwardableEmailMessage;
}

describe('automatic reply loop guard', () => {
  test.each([
    ['auto-generated', { 'auto-submitted': 'auto-generated' }],
    ['auto-replied', { 'auto-submitted': 'auto-replied' }],
    ['extension token', { 'auto-submitted': 'x-flaremail-generated' }],
    ['parameterized no', { 'auto-submitted': 'no; foo=bar' }],
    ['bulk', { precedence: 'bulk' }],
    ['list', { precedence: 'list' }],
    ['junk', { precedence: 'junk' }],
    ['list id', { 'list-id': '<list.example.test>' }],
    ['suppressed', { 'x-auto-response-suppress': 'RN' }]
  ])('skips %s messages', async (_label, headers) => {
    await expect(sendAutomaticReply(inbound('alice@example.com', headers), env, 'storage-id')).resolves.toMatchObject({ sent: false });
  });

  test('allows the RFC 3834 no token and preserves outbound loop headers', async () => {
    const result = await sendAutomaticReply(inbound('alice@example.com', { 'auto-submitted': 'no' }), env, 'storage-id');
    expect(result.sent).toBe(true);
  });

  test('uses MAIL_FROM as a runtime sender alias', async () => {
    const aliasEnv = { ...env, OUTBOUND_FROM_EMAIL: undefined, MAIL_FROM: 'legacy@example.test' } as unknown as CloudflareEnv;
    await expect(sendAutomaticReply(inbound('alice@example.com', { 'auto-submitted': 'no' }), aliasEnv, 'legacy-storage-id'))
      .resolves.toMatchObject({ sent: true });
  });

  test('rejects empty and invalid envelope senders', async () => {
    await expect(sendAutomaticReply(inbound(''), env, 'storage-id')).resolves.toMatchObject({ sent: false });
    await expect(sendAutomaticReply(inbound('not-an-email'), env, 'storage-id')).resolves.toMatchObject({ sent: false });
  });
});
