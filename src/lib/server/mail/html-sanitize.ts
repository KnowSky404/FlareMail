const textEncoder = new TextEncoder();

export const SAFE_HTML_DEFAULT_LIMITS = {
  maxInputBytes: 256 * 1024,
  maxOutputBytes: 256 * 1024,
  maxNodes: 10_000,
  maxDepth: 64
} as const;

export type SafeHtmlErrorCode =
  | 'HTML_INPUT_TOO_LARGE'
  | 'HTML_OUTPUT_TOO_LARGE'
  | 'HTML_TEXT_TOO_LARGE'
  | 'HTML_COMPLEXITY_LIMIT'
  | 'HTML_NESTING_TOO_DEEP';

export class SafeHtmlError extends Error {
  readonly name = 'SafeHtmlError';

  constructor(
    readonly code: SafeHtmlErrorCode,
    message: string,
    readonly details?: { limit: number; actual?: number }
  ) {
    super(message);
  }
}

export type CidImageResolver = (cid: string) => string | null;

export interface SafeHtmlSanitizerOptions {
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxNodes?: number;
  maxDepth?: number;
  resolveCidImage?: CidImageResolver;
}

export interface SafeHtmlResult {
  html: string;
  text: string;
  removedElements: number;
  blockedImages: number;
  allowedCidImages: number;
}

type Attribute = { name: string; value: string };
type ParsedTag = { name: string; closing: boolean; selfClosing: boolean; attributes: Attribute[] };
type Frame = { name: string; emitted: boolean };

const allowedTags = new Set([
  'p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'span',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'
]);
const voidTags = new Set(['br']);
const suppressedTags = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'form', 'object', 'embed', 'svg', 'math']);
const tagNamePattern = /^[A-Za-z][A-Za-z0-9:-]*/u;
const attributeNamePattern = /^[A-Za-z_:][A-Za-z0-9:._-]*/u;
const safeCidPathPattern = /^\/api\/(?!\/)[^\u0000-\u001f\u007f<>"']+$/u;

const namedEntities: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: '\u00a0',
  quot: '"'
};

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:#([0-9]{1,7})|#x([0-9a-f]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/giu, (full, decimal, hexadecimal, named) => {
    if (decimal !== undefined) {
      const codePoint = Number(decimal);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : full;
    }
    if (hexadecimal !== undefined) {
      const codePoint = Number.parseInt(hexadecimal, 16);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : full;
    }
    return namedEntities[named.toLowerCase()] ?? full;
  });
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;');
}

function findTagEnd(input: string, start: number): number {
  let quote = '';
  for (let index = start; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function parseTag(body: string): ParsedTag | null {
  let source = body.trim();
  if (!source || source.startsWith('!') || source.startsWith('?')) return null;

  let closing = false;
  if (source.startsWith('/')) {
    closing = true;
    source = source.slice(1).trimStart();
  }
  const nameMatch = source.match(tagNamePattern);
  if (!nameMatch) return null;
  const name = nameMatch[0].toLowerCase();
  if (closing) return { name, closing: true, selfClosing: false, attributes: [] };

  let position = nameMatch[0].length;
  let selfClosing = false;
  const attributes: Attribute[] = [];
  while (position < source.length) {
    while (/\s/u.test(source[position] ?? '')) position += 1;
    if (position >= source.length) break;
    if (source[position] === '/') {
      selfClosing = true;
      position += 1;
      continue;
    }
    const attributeMatch = source.slice(position).match(attributeNamePattern);
    if (!attributeMatch) {
      position += 1;
      continue;
    }
    const attributeName = attributeMatch[0].toLowerCase();
    position += attributeMatch[0].length;
    while (/\s/u.test(source[position] ?? '')) position += 1;
    let value = '';
    if (source[position] === '=') {
      position += 1;
      while (/\s/u.test(source[position] ?? '')) position += 1;
      const quote = source[position];
      if (quote === '"' || quote === "'") {
        position += 1;
        const end = source.indexOf(quote, position);
        if (end < 0) {
          value = source.slice(position);
          position = source.length;
        } else {
          value = source.slice(position, end);
          position = end + 1;
        }
      } else {
        const start = position;
        while (position < source.length && !/\s/u.test(source[position]) && source[position] !== '>') position += 1;
        value = source.slice(start, position);
      }
    }
    attributes.push({ name: attributeName, value: decodeEntities(value) });
  }
  return { name, closing: false, selfClosing, attributes };
}

function firstAttribute(attributes: Attribute[], name: string): string | undefined {
  return attributes.find((attribute) => attribute.name === name)?.value;
}

function normalizedUrl(value: string): string {
  return decodeEntities(value)
    .replace(/[\u0000-\u0020\u007f\u0080-\u009f]/gu, '')
    .trim();
}

function safeExternalUrl(value: string): string | null {
  const normalized = normalizedUrl(value);
  const scheme = normalized.match(/^([A-Za-z][A-Za-z0-9+.-]*):/u)?.[1]?.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') return null;
  if (scheme === 'mailto') return /^mailto:[^\s<>@]+@[^\s<>@]+/iu.test(normalized) ? normalized : null;
  try {
    const parsed = new URL(normalized);
    return parsed.hostname ? normalized : null;
  } catch {
    return null;
  }
}

function safeMappedCidUrl(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return safeCidPathPattern.test(normalized) ? normalized : null;
}

function mapAttributes(attributes: Attribute[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const attribute of attributes) {
    if (!result.has(attribute.name)) result.set(attribute.name, attribute.value);
  }
  return result;
}

export function sanitizeHtml(input: string, options: SafeHtmlSanitizerOptions = {}): SafeHtmlResult {
  const limits = { ...SAFE_HTML_DEFAULT_LIMITS, ...options };
  const inputBytes = byteLength(input);
  if (inputBytes > limits.maxInputBytes) {
    throw new SafeHtmlError('HTML_INPUT_TOO_LARGE', 'HTML 正文超过大小限制。', { limit: limits.maxInputBytes, actual: inputBytes });
  }

  let html = '';
  let text = '';
  let position = 0;
  let nodes = 0;
  let removedElements = 0;
  let blockedImages = 0;
  let allowedCidImages = 0;
  const stack: Frame[] = [];

  const checkNode = () => {
    nodes += 1;
    if (nodes > limits.maxNodes) {
      throw new SafeHtmlError('HTML_COMPLEXITY_LIMIT', 'HTML 正文结构过于复杂。', { limit: limits.maxNodes, actual: nodes });
    }
  };
  const checkDepth = () => {
    if (stack.length > limits.maxDepth) {
      throw new SafeHtmlError('HTML_NESTING_TOO_DEEP', 'HTML 正文嵌套层级过深。', { limit: limits.maxDepth, actual: stack.length });
    }
  };
  const append = (value: string) => {
    const next = html + value;
    const actual = byteLength(next);
    if (actual > limits.maxOutputBytes) {
      throw new SafeHtmlError('HTML_OUTPUT_TOO_LARGE', '清洗后的 HTML 正文超过大小限制。', { limit: limits.maxOutputBytes, actual });
    }
    html = next;
  };
  const appendPlainText = (value: string): string => {
    if (!value) return '';
    const decoded = decodeEntities(value);
    const nextText = text + decoded;
    const actual = byteLength(nextText);
    if (actual > limits.maxOutputBytes) {
      throw new SafeHtmlError('HTML_TEXT_TOO_LARGE', 'HTML 纯文本回退内容超过大小限制。', { limit: limits.maxOutputBytes, actual });
    }
    text = nextText;
    return decoded;
  };
  const appendText = (value: string) => {
    const decoded = appendPlainText(value);
    if (!decoded) return;
    append(escapeText(decoded));
  };
  const suppressed = () => stack.some((frame) => !frame.emitted);

  while (position < input.length) {
    if (input[position] !== '<') {
      const nextTag = input.indexOf('<', position);
      const end = nextTag < 0 ? input.length : nextTag;
      if (!suppressed()) appendText(input.slice(position, end));
      position = end;
      continue;
    }

    if (input.startsWith('<!--', position)) {
      checkNode();
      const end = input.indexOf('-->', position + 4);
      position = end < 0 ? input.length : end + 3;
      continue;
    }

    const tagEnd = findTagEnd(input, position + 1);
    if (tagEnd < 0) {
      if (!suppressed()) appendText(input.slice(position));
      break;
    }
    checkNode();
    const parsed = parseTag(input.slice(position + 1, tagEnd));
    position = tagEnd + 1;
    if (!parsed) continue;

    if (parsed.closing && suppressed()) {
      const suppressionIndex = stack.findIndex((frame) => !frame.emitted);
      if (suppressionIndex >= 0 && stack[suppressionIndex]?.name === parsed.name) {
        stack.splice(suppressionIndex);
      }
      continue;
    }

    if (parsed.closing) {
      const matchingIndex = stack.map((frame) => frame.name).lastIndexOf(parsed.name);
      if (matchingIndex < 0) continue;
      while (stack.length > matchingIndex) {
        const frame = stack.pop();
        if (frame?.emitted && !voidTags.has(frame.name)) append(`</${frame.name}>`);
      }
      continue;
    }

    if (suppressed()) {
      continue;
    }

    if (suppressedTags.has(parsed.name)) {
      removedElements += 1;
      stack.push({ name: parsed.name, emitted: false });
      checkDepth();
      continue;
    }

    if (parsed.name === 'img') {
      const source = firstAttribute(parsed.attributes, 'src');
      const alt = firstAttribute(parsed.attributes, 'alt') ?? '';
      const cid = source?.match(/^cid:(.+)$/iu)?.[1]?.trim();
      if (cid && options.resolveCidImage) {
        const mapped = safeMappedCidUrl(options.resolveCidImage(cid));
        if (mapped) {
          const altAttribute = alt ? ` alt="${escapeAttribute(alt)}"` : '';
          append(`<img src="${escapeAttribute(mapped)}"${altAttribute}>`);
          allowedCidImages += 1;
          if (alt) appendPlainText(alt);
          continue;
        }
      }
      blockedImages += 1;
      removedElements += 1;
      if (alt) appendText(alt);
      continue;
    }

    if (!allowedTags.has(parsed.name)) {
      removedElements += 1;
      continue;
    }

    if (parsed.name === 'a') {
      const href = firstAttribute(parsed.attributes, 'href');
      const safeHref = href ? safeExternalUrl(href) : null;
      if (!safeHref) {
        removedElements += 1;
        continue;
      }
      append(`<a href="${escapeAttribute(safeHref)}" target="_blank" rel="noopener noreferrer">`);
      stack.push({ name: parsed.name, emitted: true });
      checkDepth();
      continue;
    }

    const attributes = mapAttributes(parsed.attributes);
    let serializedAttributes = '';
    if (parsed.name === 'th' || parsed.name === 'td') {
      for (const name of ['colspan', 'rowspan']) {
        const value = attributes.get(name);
        if (value && /^[1-9][0-9]{0,2}$/u.test(value)) serializedAttributes += ` ${name}="${value}"`;
      }
    }
    append(`<${parsed.name}${serializedAttributes}>`);
    if (!voidTags.has(parsed.name) && !parsed.selfClosing) {
      stack.push({ name: parsed.name, emitted: true });
      checkDepth();
    }
  }

  while (stack.length) {
    const frame = stack.pop();
    if (frame?.emitted && !voidTags.has(frame.name)) append(`</${frame.name}>`);
  }

  return { html, text, removedElements, blockedImages, allowedCidImages };
}
