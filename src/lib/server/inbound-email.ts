import type { InboundMessageDetail, MailAttachmentSummary } from '$lib/mock/mailbox';

const decoder = new TextDecoder();

type HeaderMap = Record<string, string>;

type ParsedHeaderValue = {
  value: string;
  params: Record<string, string>;
};

type ParsedMimeResult = {
  textBodies: string[];
  htmlBodies: string[];
  attachments: MailAttachmentSummary[];
};

const normalizeNewlines = (value: string) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const normalizeVisibleText = (value: string) =>
  normalizeNewlines(value)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const collapseWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

const decodeHtmlEntities = (value: string) =>
  value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

const stripHtml = (value: string) =>
  normalizeVisibleText(
    decodeHtmlEntities(
      value
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
    )
  );

const splitHeaderBody = (value: string) => {
  const normalized = normalizeNewlines(value);
  const separatorIndex = normalized.indexOf('\n\n');

  if (separatorIndex === -1) {
    return {
      headerText: normalized,
      bodyText: ''
    };
  }

  return {
    headerText: normalized.slice(0, separatorIndex),
    bodyText: normalized.slice(separatorIndex + 2)
  };
};

const parseHeaders = (headerText: string): HeaderMap => {
  const headers: HeaderMap = {};
  let currentName = '';

  for (const rawLine of normalizeNewlines(headerText).split('\n')) {
    if (!rawLine) {
      continue;
    }

    if (/^[ \t]/.test(rawLine) && currentName) {
      headers[currentName] = `${headers[currentName]} ${rawLine.trim()}`.trim();
      continue;
    }

    const separatorIndex = rawLine.indexOf(':');

    if (separatorIndex === -1) {
      continue;
    }

    currentName = rawLine.slice(0, separatorIndex).trim().toLowerCase();
    headers[currentName] = rawLine.slice(separatorIndex + 1).trim();
  }

  return headers;
};

const parseHeaderValue = (value: string): ParsedHeaderValue => {
  const segments = value.split(';').map((segment) => segment.trim()).filter(Boolean);
  const [rawValue = '', ...rawParams] = segments;
  const params: Record<string, string> = {};

  for (const segment of rawParams) {
    const separatorIndex = segment.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = segment.slice(0, separatorIndex).trim().toLowerCase();
    const rawParamValue = segment.slice(separatorIndex + 1).trim();
    const normalizedValue = rawParamValue.replace(/^"(.*)"$/, '$1');
    params[key] = normalizedValue;
  }

  return {
    value: rawValue.toLowerCase(),
    params
  };
};

const decodeExtendedParameter = (value: string) => {
  const match = value.match(/^[^']*'[^']*'(.*)$/);

  if (!match) {
    return value;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

const getFilename = (params: Record<string, string>) => {
  const rawValue =
    params['filename*'] ??
    params.filename ??
    params['name*'] ??
    params.name ??
    '';

  if (!rawValue) {
    return 'attachment.bin';
  }

  return decodeExtendedParameter(rawValue);
};

const toAsciiBytes = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0));

const decodeBase64Bytes = (value: string) => {
  try {
    const normalized = value.replace(/\s+/g, '');
    const binary = atob(normalized);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return toAsciiBytes(value);
  }
};

const decodeQuotedPrintableBytes = (value: string) => {
  const normalized = value.replace(/=\n/g, '').replace(/=\r\n/g, '');
  const bytes: number[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];

    if (current === '=' && /^[0-9A-Fa-f]{2}$/.test(normalized.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(normalized.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }

    bytes.push(current.charCodeAt(0));
  }

  return new Uint8Array(bytes);
};

const decodeBodyBytes = (value: string, encoding: string) => {
  switch (encoding.toLowerCase()) {
    case 'base64':
      return decodeBase64Bytes(value);
    case 'quoted-printable':
      return decodeQuotedPrintableBytes(value);
    default:
      return toAsciiBytes(value);
  }
};

const decodeBodyText = (value: string, encoding: string, charset: string) => {
  const bytes = decodeBodyBytes(value, encoding);

  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return decoder.decode(bytes);
  }
};

const splitMultipart = (bodyText: string, boundary: string) => {
  const marker = `--${boundary}`;
  const sections = normalizeNewlines(bodyText).split(marker).slice(1);
  const parts: string[] = [];

  for (const section of sections) {
    const cleaned = section.replace(/^\n/, '').trim();

    if (!cleaned || cleaned === '--' || cleaned.startsWith('--')) {
      continue;
    }

    parts.push(cleaned);
  }

  return parts;
};

const collectMimePart = (rawPart: string, target: ParsedMimeResult) => {
  const { headerText, bodyText } = splitHeaderBody(rawPart);
  const headers = parseHeaders(headerText);
  const contentType = parseHeaderValue(headers['content-type'] ?? 'text/plain; charset=utf-8');
  const disposition = parseHeaderValue(headers['content-disposition'] ?? '');
  const transferEncoding = headers['content-transfer-encoding'] ?? '7bit';
  const boundary = contentType.params.boundary;
  const charset = contentType.params.charset ?? 'utf-8';

  if (contentType.value.startsWith('multipart/') && boundary) {
    for (const part of splitMultipart(bodyText, boundary)) {
      collectMimePart(part, target);
    }

    return;
  }

  const hasAttachmentName = Boolean(
    disposition.params.filename ||
      disposition.params['filename*'] ||
      contentType.params.name ||
      contentType.params['name*']
  );
  const isAttachment = disposition.value === 'attachment' || hasAttachmentName;

  if (isAttachment) {
    const payload = decodeBodyBytes(bodyText, transferEncoding);

    target.attachments.push({
      filename: getFilename({ ...contentType.params, ...disposition.params }),
      contentType: contentType.value || 'application/octet-stream',
      size: payload.byteLength,
      inline: disposition.value === 'inline'
    });
    return;
  }

  const decodedText = decodeBodyText(bodyText, transferEncoding, charset);

  if (contentType.value === 'text/html') {
    const normalizedHtmlText = stripHtml(decodedText);

    if (normalizedHtmlText) {
      target.htmlBodies.push(normalizedHtmlText);
    }
    return;
  }

  const normalizedText = normalizeVisibleText(decodedText);

  if (normalizedText) {
    target.textBodies.push(normalizedText);
  }
};

const parseMimeMessage = (rawText: string): ParsedMimeResult => {
  const result: ParsedMimeResult = {
    textBodies: [],
    htmlBodies: [],
    attachments: []
  };

  collectMimePart(normalizeNewlines(rawText), result);
  return result;
};

const extractBodyFallback = (rawText: string) => {
  const { bodyText } = splitHeaderBody(rawText);
  return stripHtml(bodyText) || normalizeVisibleText(bodyText);
};

export function parseInboundEmail(raw: ArrayBuffer): InboundMessageDetail & { snippet: string } {
  const rawText = decoder.decode(raw);
  const parsed = parseMimeMessage(rawText);
  const body =
    parsed.textBodies.find(Boolean) ??
    parsed.htmlBodies.find(Boolean) ??
    extractBodyFallback(rawText) ??
    '(empty body)';

  return {
    body,
    attachments: parsed.attachments,
    rawSize: raw.byteLength,
    snippet: collapseWhitespace(body).slice(0, 240) || '(empty body)'
  };
}
