import { describe, expect, test } from 'bun:test';
import { buildTelegramNotification, formatTelegramReceivedAt } from './message';

const input = {
  appBaseUrl: 'https://mail.example.test',
  emailMessageId: 'message-1',
  from: 'Sender <sender@example.test>',
  to: 'owner@example.test',
  subject: 'Subject',
  receivedAt: '2026-09-09T12:00:00.000Z',
  attachmentCount: 2,
  snippet: 'A short summary.',
  privacyMode: false,
  summaryEnabled: true
};

describe('Telegram notification formatting', () => {
  test('uses the existing mailbox URL state and excludes body/attachments', () => {
    const payload = buildTelegramNotification(input);
    expect(payload.disable_web_page_preview).toBe(true);
    expect(payload.text).toContain('发件人：Sender <sender@example.test>');
    expect(payload.text).toContain('摘要：A short summary.');
    expect(payload.text).not.toContain('raw/');
    const url = new URL(payload.reply_markup.inline_keyboard[0]![0]!.url);
    expect(url.origin).toBe('https://mail.example.test');
    expect(url.searchParams.get('folder')).toBe('inbox');
    expect(url.searchParams.get('message')).toBe('email:message-1');
  });

  test('privacy mode is minimal and sanitizes bounded untrusted content', () => {
    const payload = buildTelegramNotification({
      ...input,
      privacyMode: true,
      subject: `bad\u0000\n${'x'.repeat(10_000)}`,
      snippet: 'should not be included'
    });
    expect(payload.text).toBe('FlareMail：收到一封新邮件。');
    expect(payload.text).not.toContain('should not be included');
    expect(payload.text).not.toContain('\u0000');
    expect(Array.from(payload.text).length).toBeLessThanOrEqual(4096);
  });

  test('caps long summaries below the Telegram message limit', () => {
    const payload = buildTelegramNotification({ ...input, snippet: '摘要'.repeat(5_000) });
    expect(Array.from(payload.text).length).toBeLessThanOrEqual(3900);
  });

  test('keeps untrusted notification fields plain and non-clickable', () => {
    const payload = buildTelegramNotification({
      ...input,
      subject: '<b>https://subject.example.test</b>',
      snippet: 'line one\nhttps://body.example.test/path <a href="https://link.example.test">link</a>'
    });
    expect(payload.text).not.toContain('<b>');
    expect(payload.text).not.toContain('<a ');
    expect(payload.text).not.toContain('https://subject.example.test');
    expect(payload.text).not.toContain('https://body.example.test');
    expect(payload.text).not.toContain('https://link.example.test');
    expect(payload.text).not.toContain('\nline');
    expect(payload.text).toContain('[链接已省略]');
  });

  test('formats the persisted server receipt time in the workspace timezone and falls back safely', () => {
    const receivedAt = '2026-09-09T12:00:00.000Z';
    expect(formatTelegramReceivedAt(receivedAt, 'Europe/Berlin')).toBe(
      new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(new Date(receivedAt))
    );
    expect(formatTelegramReceivedAt(receivedAt, 'not/a-timezone')).toBe(
      new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(receivedAt))
    );
  });
});
