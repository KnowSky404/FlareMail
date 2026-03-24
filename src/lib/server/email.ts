import type { CloudflareEnv } from './cloudflare';

const decoder = new TextDecoder();

const collapseWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

const stripHtml = (value: string) =>
  value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

const extractBody = (rawText: string) => {
  const separator = rawText.search(/\r?\n\r?\n/);
  return separator === -1 ? rawText : rawText.slice(separator).trim();
};

const createSnippet = (raw: ArrayBuffer) => {
  const body = stripHtml(extractBody(decoder.decode(raw)));
  return collapseWhitespace(body).slice(0, 240);
};

const toIsoTimestamp = (value: string | null) => {
  if (!value) {
    return new Date().toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
};

export async function handleInboundEmail(message: ForwardableEmailMessage, env: CloudflareEnv) {
  try {
    const id = crypto.randomUUID();
    const raw = await new Response(message.raw).arrayBuffer();
    const subject = message.headers.get('subject') ?? '(no subject)';
    const timestamp = toIsoTimestamp(message.headers.get('date'));
    const snippet = createSnippet(raw) || '(empty body)';
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
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Failed to store inbound email.';
    message.setReject(reason);
    throw error;
  }
}
