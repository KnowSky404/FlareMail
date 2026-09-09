import { toInboundMessageId } from '$lib/domain/mail';
import { cleanTelegramLine, cleanTelegramText, truncateTelegramText } from './utils';

export interface TelegramNotificationInput {
  appBaseUrl: string;
  emailMessageId: string;
  from: string;
  to: string;
  subject: string;
  receivedAt: string;
  timezone?: string;
  attachmentCount: number;
  snippet: string;
  privacyMode: boolean;
  summaryEnabled: boolean;
}

export interface TelegramNotificationPayload {
  text: string;
  disable_web_page_preview: true;
  reply_markup: {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  };
}

function messageUrl(appBaseUrl: string, emailMessageId: string) {
  const url = new URL(appBaseUrl);
  url.searchParams.set('folder', 'inbox');
  url.searchParams.set('message', toInboundMessageId(emailMessageId));
  return url.toString();
}

export function formatTelegramReceivedAt(receivedAt: string, timezone = 'UTC') {
  const date = new Date(receivedAt);
  if (Number.isNaN(date.valueOf())) return '(未知)';
  let safeTimezone = 'UTC';
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: timezone || 'UTC' }).format(date);
    safeTimezone = timezone || 'UTC';
  } catch {
    // A user can have an old or manually entered timezone value. Keep the
    // notification useful without allowing an invalid Intl option to abort it.
  }
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: safeTimezone
  }).format(date);
}

export function buildTelegramNotification(input: TelegramNotificationInput): TelegramNotificationPayload {
  const url = messageUrl(input.appBaseUrl, input.emailMessageId);
  const button = { text: '在 FlareMail 中查看', url };
  if (input.privacyMode) {
    return {
      text: 'FlareMail：收到一封新邮件。',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[button]] }
    };
  }

  const lines = [
    'FlareMail：收到新邮件',
    `发件人：${truncateTelegramText(cleanTelegramLine(input.from, '(未知)'), 240)}`,
    `收件地址：${truncateTelegramText(cleanTelegramLine(input.to, '(未知)'), 254)}`,
    `主题：${truncateTelegramText(cleanTelegramLine(input.subject, '(无主题)'), 300)}`,
    `收到时间：${truncateTelegramText(cleanTelegramLine(formatTelegramReceivedAt(input.receivedAt, input.timezone), '(未知)'), 64)}`,
    `附件：${Math.max(0, Math.trunc(input.attachmentCount))} 个`
  ];
  if (input.summaryEnabled) {
    const summary = truncateTelegramText(cleanTelegramText(input.snippet, '(无摘要)'), 300);
    lines.push(`摘要：${summary}`);
  }

  let text = lines.join('\n');
  if (Array.from(text).length > 3900) text = `${Array.from(text).slice(0, 3899).join('')}…`;
  return {
    text,
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[button]] }
  };
}

export function buildTelegramHelpPayload(appBaseUrl: string): TelegramNotificationPayload {
  return {
    text: 'FlareMail Telegram 绑定助手：请从 FlareMail 设置生成绑定链接，然后打开链接并发送 /start。没有绑定链接时不会开启通知。',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: '打开 FlareMail', url: appBaseUrl }]] }
  };
}
