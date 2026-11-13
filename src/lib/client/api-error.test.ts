import { expect, test } from 'bun:test';
import { createTranslator } from '$lib/i18n';
import { ClientApiError } from './api';
import { formatApiError } from './api-error';

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
