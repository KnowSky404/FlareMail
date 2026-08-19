import PostalMime from 'postal-mime';
import type { Address, Attachment, Email, Mailbox } from 'postal-mime';

/** A mailbox address with a display name decoded by postal-mime. */
export interface ParsedInboundAddress {
  name: string;
  address: string;
}

export interface ParsedInboundAttachment {
  content: Uint8Array;
  filename: string;
  mimeType: string;
  contentId: string | null;
  inline: boolean;
  size: number;
}

export interface ParsedInboundEmail {
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  from: ParsedInboundAddress | null;
  replyTo: ParsedInboundAddress[];
  to: ParsedInboundAddress[];
  cc: ParsedInboundAddress[];
  subject: string;
  date: string | null;
  text: string;
  html: string;
  attachments: ParsedInboundAttachment[];
  /** Plain-text preview suitable for a mailbox list; never HTML markup. */
  snippet: string;
}

export interface ParseInboundMimeOptions {
  maxAttachmentCount?: number;
  maxAttachmentSize?: number;
  maxAttachmentTotalSize?: number;
  /** Postal-MIME parser safety limits. */
  maxNestingDepth?: number;
  maxHeadersSize?: number;
}

export type InboundMimeLimitKind = 'attachment_count' | 'attachment_size' | 'attachment_total_size';

/** A typed, non-sensitive failure raised when an inbound MIME limit is exceeded. */
export class InboundMimeLimitError extends Error {
  readonly code = 'INBOUND_MIME_LIMIT';

  constructor(
    readonly kind: InboundMimeLimitKind,
    readonly limit: number,
    readonly actual: number
  ) {
    super(`Inbound MIME ${kind.replaceAll('_', ' ')} exceeds configured limit.`);
    this.name = 'InboundMimeLimitError';
  }
}

/** A typed parse failure. The raw message is deliberately never retained on the error. */
export class InboundMimeParseError extends Error {
  readonly code = 'INBOUND_MIME_PARSE_FAILED';

  constructor(cause?: unknown) {
    super('The inbound MIME message could not be parsed.');
    this.name = 'InboundMimeParseError';
    if (cause !== undefined) this.cause = cause;
  }
}

const cleanHeader = (value: string | undefined | null): string | null => {
  const cleaned = value?.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() ?? '';
  return cleaned || null;
};

const mailbox = (value: Mailbox): ParsedInboundAddress | null => {
  const address = value.address.trim();
  if (!address) return null;
  return { name: value.name.trim(), address };
};

const flattenAddress = (value: Address | undefined): ParsedInboundAddress[] => {
  if (!value) return [];
  if ('address' in value && value.address) {
    const parsed = mailbox(value);
    return parsed ? [parsed] : [];
  }
  if ('group' in value) return (value.group ?? []).flatMap((entry) => {
    const parsed = mailbox(entry);
    return parsed ? [parsed] : [];
  });
  return [];
};

const flattenAddresses = (values: Address[] | undefined): ParsedInboundAddress[] =>
  values?.flatMap(flattenAddress) ?? [];

const attachmentBytes = (content: Attachment['content']): Uint8Array => {
  if (content instanceof Uint8Array) return new Uint8Array(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content.slice(0));
  // arraybuffer is requested below, but retaining this fallback keeps the
  // adapter defensive if postal-mime changes its runtime representation.
  return new TextEncoder().encode(content);
};

const htmlToSnippet = (html: string): string =>
  html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

const safeSnippet = (text: string, html: string): string => {
  const source = text.trim() || htmlToSnippet(html);
  return source.replace(/\s+/g, ' ').trim().slice(0, 240);
};

const enforceLimits = (attachments: ParsedInboundAttachment[], options: ParseInboundMimeOptions) => {
  if (options.maxAttachmentCount !== undefined && attachments.length > options.maxAttachmentCount) {
    throw new InboundMimeLimitError('attachment_count', options.maxAttachmentCount, attachments.length);
  }

  let total = 0;
  for (const attachment of attachments) {
    if (options.maxAttachmentSize !== undefined && attachment.size > options.maxAttachmentSize) {
      throw new InboundMimeLimitError('attachment_size', options.maxAttachmentSize, attachment.size);
    }
    total += attachment.size;
    if (options.maxAttachmentTotalSize !== undefined && total > options.maxAttachmentTotalSize) {
      throw new InboundMimeLimitError('attachment_total_size', options.maxAttachmentTotalSize, total);
    }
  }
};

const normalizeAttachment = (attachment: Attachment): ParsedInboundAttachment => {
  const content = attachmentBytes(attachment.content);
  const mimeType = attachment.mimeType.trim().toLowerCase();
  return {
    content,
    filename: attachment.filename?.trim() || 'attachment.bin',
    mimeType: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mimeType) ? mimeType : 'application/octet-stream',
    contentId: cleanHeader(attachment.contentId),
    inline: attachment.disposition === 'inline' || attachment.related === true,
    size: content.byteLength
  };
};

const normalizeParsedEmail = (email: Email, options: ParseInboundMimeOptions): ParsedInboundEmail => {
  const text = email.text?.trim() ?? '';
  const html = email.html?.trim() ?? '';
  const attachments = email.attachments.map(normalizeAttachment);
  enforceLimits(attachments, options);

  return {
    messageId: cleanHeader(email.messageId),
    inReplyTo: cleanHeader(email.inReplyTo),
    references: cleanHeader(email.references),
    from: flattenAddress(email.from)[0] ?? null,
    replyTo: flattenAddresses(email.replyTo),
    to: flattenAddresses(email.to),
    cc: flattenAddresses(email.cc),
    subject: email.subject?.trim() ?? '',
    date: cleanHeader(email.date),
    text,
    html,
    attachments,
    snippet: safeSnippet(text, html)
  };
};

/**
 * Parse a complete RFC 5322 message held in an ArrayBuffer.
 *
 * The caller owns the buffer and this function never consumes a stream. The
 * parser is intentionally kept at the server boundary so UI code receives
 * data rather than MIME or HTML rendering concerns.
 */
export async function parseInboundMime(raw: ArrayBuffer, options: ParseInboundMimeOptions = {}): Promise<ParsedInboundEmail> {
  try {
    const email = await PostalMime.parse(raw, {
      attachmentEncoding: 'arraybuffer',
      maxNestingDepth: options.maxNestingDepth ?? 20,
      maxHeadersSize: options.maxHeadersSize ?? 128 * 1024
    });
    return normalizeParsedEmail(email, options);
  } catch (error) {
    if (error instanceof InboundMimeLimitError) throw error;
    throw new InboundMimeParseError(error);
  }
}

/** Descriptive alias for callers that prefer the full operation name. */
export const parseInboundEmailMime = parseInboundMime;
