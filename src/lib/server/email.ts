import type { CloudflareEnv } from './cloudflare';
import { sendCloudflareAutoReply, sendInboundNotification } from './cloudflare-email';
import { parseInboundEmail } from './inbound-email';

const toIsoTimestamp = (value: string | null) => {
  if (!value) {
    return new Date().toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
};

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: CloudflareEnv,
  ctx?: ExecutionContext
) {
  try {
    const id = crypto.randomUUID();
    const raw = await new Response(message.raw).arrayBuffer();
    const subject = message.headers.get('subject') ?? '(no subject)';
    const timestamp = toIsoTimestamp(message.headers.get('date'));
    const snippet = parseInboundEmail(raw).snippet || '(empty body)';
    const messageId = message.headers.get('message-id');
    const rawKey = `emails/${timestamp.slice(0, 10)}/${id}.eml`;

    await env.BUCKET.put(rawKey, raw, {
      httpMetadata: {
        contentType: 'message/rfc822'
      },
      customMetadata: {
        from: message.from,
        to: message.to,
        subject: subject.slice(0, 256)
      }
    });

    await env.DB.prepare(
      `
        INSERT INTO email_messages (
          id,
          message_id,
          "from",
          "to",
          subject,
          "timestamp",
          snippet,
          raw_key,
          raw_size
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
      .bind(
        id,
        messageId,
        message.from,
        message.to,
        subject,
        timestamp,
        snippet,
        rawKey,
        raw.byteLength
      )
      .run();

    const followUpTasks = [
      sendInboundNotification(env, {
        from: message.from,
        to: message.to,
        subject,
        timestamp,
        snippet,
        rawKey
      }).catch((error) => {
        console.error('Failed to send inbound notification', error);
        return null;
      }),
      sendCloudflareAutoReply(message, env).catch((error) => {
        console.error('Failed to send auto reply', error);
        return null;
      })
    ];

    if (ctx) {
      ctx.waitUntil(Promise.all(followUpTasks));
    } else {
      await Promise.all(followUpTasks);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Failed to store inbound email.';
    message.setReject(reason);
    throw error;
  }
}
