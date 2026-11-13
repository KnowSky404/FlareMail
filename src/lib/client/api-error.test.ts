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

test('preserves delivery and draft recovery instructions and safe request IDs', () => {
  const cases = [
    ['DELIVERY_REVIEW_REQUIRED', 'Resend Dashboard', '投递时间线'],
    ['DELIVERY_NOT_RETRYABLE', 'delivery timeline first', '先检查投递时间线'],
    ['IDEMPOTENCY_CONFLICT', 'avoid sending a duplicate', '避免重复发送'],
    ['DRAFT_BODY_RELOAD_REQUIRED', 'complete body', '完整正文'],
    ['DRAFT_CONFLICT', 'latest server version', '最新服务器版本'],
    ['SEND_RATE_LIMITED', 'Wait before', '稍后再试']
  ] as const;
  for (const [code, englishAdvice, chineseAdvice] of cases) {
    const error = new ClientApiError(409, code, '原始后端提示', 'proxy:trace.123');
    const english = formatApiError(error, createTranslator('en'), 'Failed');
    expect(english).toContain(englishAdvice);
    expect(english).toContain('proxy:trace.123');
    expect(english).not.toMatch(/\p{Script=Han}/u);
    expect(formatApiError(error, createTranslator('zh-CN'), '失败')).toContain(chineseAdvice);
  }
});

test('preserves trusted translated validation advice and filenames in both languages', () => {
  for (const locale of ['en', 'zh-CN'] as const) {
    const t = createTranslator(locale);
    const message = t('compose.forwardAttachmentLimit', { filename: 'report.pdf' });
    expect(formatApiError(new LocalizedError(message), t, 'fallback')).toBe(message);
    expect(message).toContain('report.pdf');
  }
});

test('keeps login and Telegram recovery steps in both languages', () => {
  for (const [code, englishAdvice, chineseAdvice] of [
    ['LOGIN_RATE_LIMITED', 'Wait before', '稍后再试'],
    ['INVALID_CREDENTIALS', 'Check your credentials', '检查后重试'],
    ['LOCAL_LOGIN_DISABLED', 'Sign in through Access', 'Access 登录'],
    ['TELEGRAM_CANDIDATE_REQUIRED', '/start', '/start'],
    ['TELEGRAM_ALREADY_BOUND', 'Unbind it before', '先解除绑定'],
    ['TELEGRAM_RATE_LIMITED', 'Wait before', '稍后再试']
  ] as const) {
    const error = new ClientApiError(409, code, '原始后端中文提示');
    const english = formatApiError(error, createTranslator('en'), 'Failed');
    expect(english).toContain(englishAdvice);
    expect(english).not.toMatch(/\p{Script=Han}/u);
    expect(formatApiError(error, createTranslator('zh-CN'), '失败')).toContain(chineseAdvice);
  }
});
