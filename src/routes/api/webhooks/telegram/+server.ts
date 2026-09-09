import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { hasTelegramTables, consumeTelegramChallenge, findTelegramBindingByChat, recordTelegramIgnoredUpdate, revokeTelegramBinding } from '$lib/server/db/telegram';
import { resolveTelegramConfig } from '$lib/server/telegram/config';
import { buildTelegramHelpPayload } from '$lib/server/telegram/message';
import { sendTelegramMessage } from '$lib/server/telegram/api';
import { normalizeTelegramId, sha256Base64Url, cleanTelegramLine } from '$lib/server/telegram/utils';

export const _maxTelegramWebhookBodyBytes = 64 * 1024;

class TelegramWebhookBodyTooLargeError extends Error {}

async function readBoundedBody(request: Request) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > _maxTelegramWebhookBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TelegramWebhookBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function constantTimeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

interface TelegramUpdate {
  update_id?: unknown;
  message?: {
    text?: unknown;
    from?: { id?: unknown; is_bot?: unknown; username?: unknown; first_name?: unknown; last_name?: unknown };
    chat?: { id?: unknown; type?: unknown; username?: unknown; first_name?: unknown; last_name?: unknown };
  };
}

function parseCommand(text: string, botUsername: string | null) {
  const match = text.trim().match(/^\/(start|stop|help)(?:@([A-Za-z0-9_]{5,32}))?(?:\s+([^\s]{1,64}))?\s*$/iu);
  if (!match) return null;
  if (match[2] && (!botUsername || match[2].toLowerCase() !== botUsername.toLowerCase())) return null;
  return { command: match[1].toLowerCase(), argument: match[3] ?? null };
}

function displayName(from: NonNullable<TelegramUpdate['message']>['from']) {
  const name = [from?.first_name, from?.last_name].filter((value): value is string => typeof value === 'string').join(' ').trim();
  return cleanTelegramLine(name || (typeof from?.username === 'string' ? `@${from.username}` : ''), 'Telegram 用户').slice(0, 160);
}

async function sendBestEffort(env: CloudflareEnv, chatId: string, text: string, replyMarkup?: Record<string, unknown>) {
  await sendTelegramMessage(env, {
    chatId,
    text,
    disableWebPagePreview: true,
    replyMarkup
  }).catch(() => undefined);
}

export const POST: RequestHandler = async (event) => {
  const env = event.platform?.env as CloudflareEnv | undefined;
  const configuredSecret = env?.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '';
  const suppliedSecret = event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';

  // This check deliberately happens before body parsing and before any D1
  // access. The route is also excluded from the normal session preflight in
  // hooks.server.ts for the same reason.
  if (!configuredSecret || !constantTimeEqual(configuredSecret, suppliedSecret)) {
    return json({ ok: false, error: 'Webhook verification failed.' }, { status: 401 });
  }

  const config = resolveTelegramConfig(env);
  if (!config.enabled) return json({ ok: false, code: 'TELEGRAM_DISABLED' }, { status: 404 });
  if (!config.ready || !env?.DB) return json({ ok: false, code: 'TELEGRAM_NOT_READY' }, { status: 503 });

  const declaredLength = Number(event.request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > _maxTelegramWebhookBodyBytes) {
    return json({ ok: false, code: 'WEBHOOK_BODY_TOO_LARGE' }, { status: 413 });
  }
  let body: string;
  try {
    body = await readBoundedBody(event.request);
  } catch (error) {
    if (error instanceof TelegramWebhookBodyTooLargeError) return json({ ok: false, code: 'WEBHOOK_BODY_TOO_LARGE' }, { status: 413 });
    return json({ ok: false, code: 'WEBHOOK_BODY_INVALID' }, { status: 400 });
  }

  let update: TelegramUpdate;
  try {
    update = JSON.parse(body) as TelegramUpdate;
  } catch {
    return json({ ok: false, code: 'INVALID_UPDATE' }, { status: 400 });
  }
  const updateId = normalizeTelegramId(update.update_id);
  if (!updateId) return json({ ok: false, code: 'INVALID_UPDATE_ID' }, { status: 400 });
  if (!await hasTelegramTables(env.DB)) return json({ ok: false, code: 'SCHEMA_NOT_READY' }, { status: 503 });

  const message = update.message;
  const chatId = normalizeTelegramId(message?.chat?.id);
  const userId = normalizeTelegramId(message?.from?.id);
  const isPrivateUserMessage = Boolean(
    message && chatId && userId && chatId === userId && message.chat?.type === 'private' && message.from?.is_bot !== true
  );
  if (!isPrivateUserMessage) {
    await recordTelegramIgnoredUpdate(env.DB, updateId, 'not_private_user_message').catch(() => undefined);
    return json({ ok: true });
  }

  const command = typeof message?.text === 'string' ? parseCommand(message.text, config.botUsername) : null;
  if (!command) {
    await recordTelegramIgnoredUpdate(env.DB, updateId, 'ignored_message').catch(() => undefined);
    return json({ ok: true });
  }

  if (command.command === 'help' || (command.command === 'start' && !command.argument)) {
    if (await recordTelegramIgnoredUpdate(env.DB, updateId, 'help').catch(() => false)) {
      const help = buildTelegramHelpPayload(config.appBaseUrl!);
      const ctx = event.platform?.context ?? event.platform?.ctx;
      ctx?.waitUntil(sendBestEffort(env, chatId!, help.text, help.reply_markup));
    }
    return json({ ok: true });
  }

  if (command.command === 'stop') {
    const recorded = await recordTelegramIgnoredUpdate(env.DB, updateId, 'stop').catch(() => false);
    if (recorded) {
      const binding = await findTelegramBindingByChat(env.DB, chatId!);
      if (binding) await revokeTelegramBinding(env.DB, binding.user_id);
      const ctx = event.platform?.context ?? event.platform?.ctx;
      ctx?.waitUntil(sendBestEffort(env, chatId!, binding ? 'FlareMail Telegram 通知已停用并解除绑定。' : '当前聊天没有已绑定的 FlareMail 账号。'));
    }
    return json({ ok: true });
  }

  const challengeToken = command.argument!;
  if (!/^[A-Za-z0-9_-]{32,64}$/u.test(challengeToken)) {
    await recordTelegramIgnoredUpdate(env.DB, updateId, 'invalid_challenge_token').catch(() => undefined);
    return json({ ok: true });
  }
  const processingToken = crypto.randomUUID();
  const outcome = await consumeTelegramChallenge(env.DB, {
    updateId,
    processingToken,
    challengeHash: await sha256Base64Url(challengeToken),
    telegramUserId: userId!,
    telegramChatId: chatId!,
    telegramUsername: typeof message?.from?.username === 'string' ? message.from.username.slice(0, 64) : null,
    telegramDisplayName: displayName(message?.from),
    now: new Date().toISOString()
  });
  if (outcome === 'bound') {
    const text = '此 Telegram 私聊已识别。请回到 FlareMail 设置点击“确认绑定”，确认后再单独开启通知。';
    const ctx = event.platform?.context ?? event.platform?.ctx;
    ctx?.waitUntil(sendBestEffort(env, chatId!, text));
  } else if (outcome === 'invalid' || outcome === 'conflict') {
    const ctx = event.platform?.context ?? event.platform?.ctx;
    ctx?.waitUntil(sendBestEffort(env, chatId!, outcome === 'invalid' ? '绑定链接已过期或无效，请回到 FlareMail 设置重新生成。' : '此 Telegram 聊天已被其他工作区绑定。'));
  }
  return json({ ok: true });
};
