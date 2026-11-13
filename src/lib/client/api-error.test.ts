import { expect, test } from 'bun:test';
import { createTranslator } from '$lib/i18n';
import { ClientApiError } from './api';
import { formatApiError, LocalizedError } from './api-error';

test('translates API errors by stable code rather than server message', () => {
  const error = new ClientApiError(409, 'MAIL_DOMAIN_COLLECT_NOT_READY', '后端中文提示', 'request-123');
  const english = formatApiError(error, createTranslator('en'), 'Failed');
  expect(english).toContain('Check status first');
  expect(english).toContain('request-123');
  expect(english).not.toMatch(/\p{Script=Han}/u);
  expect(formatApiError(error, createTranslator('zh-CN'), '失败')).toContain('确认 catch-all');
});

test('unknown and network errors use localized fallbacks without leaking raw messages', () => {
  const t = createTranslator('en');
  expect(formatApiError(new ClientApiError(500, 'NEW_FAILURE', '中文'), t, 'Failed')).toContain('NEW_FAILURE');
  expect(formatApiError(new Error('sensitive server response'), t, 'Failed')).toBe('Failed');
  expect(formatApiError(new ClientApiError(0, 'NETWORK_OFFLINE', '中文'), t, 'Failed')).toContain('offline');
  expect(formatApiError(new ClientApiError(500, '<unsafe>', 'secret', '<request>'), t, 'Failed')).not.toContain('<');
});

test('keeps attachment conflict recovery advice in both languages', () => {
  const error = new ClientApiError(409, 'ATTACHMENT_CONFLICT', '草稿附件已在其他会话中更新，请重新载入。');
  const english = formatApiError(error, createTranslator('en'), 'Failed');
  expect(english).toContain('Reload the draft');
  expect(english).not.toMatch(/\p{Script=Han}/u);
  expect(formatApiError(error, createTranslator('zh-CN'), '失败')).toContain('重新载入草稿');
});

test('preserves trusted translated validation advice and filenames in both languages', () => {
  for (const locale of ['en', 'zh-CN'] as const) {
    const t = createTranslator(locale);
    const message = t('compose.forwardAttachmentLimit', { filename: 'report.pdf' });
    expect(formatApiError(new LocalizedError(message), t, 'fallback')).toBe(message);
    expect(message).toContain('report.pdf');
  }
});
