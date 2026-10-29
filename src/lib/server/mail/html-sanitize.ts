import { defaultTreeAdapter, html as html5, parseFragment, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import { emailCssIdentifier, sanitizeEmailInlineCss, sanitizeEmailStylesheet } from './css-sanitize';

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
  | 'HTML_CONTENT_EMPTY'
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
  /** Reader-only presentation; compose/provider HTML retains its existing policy. */
  preserveStyles?: boolean;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxNodes?: number;
  maxDepth?: number;
  resolveCidImage?: CidImageResolver;
  allowRemoteImages?: boolean;
  /** Display-only risk annotations are disabled for outbound provider HTML. */
  decorateLinks?: boolean;
}

export interface SafeHtmlResult {
  html: string;
  styles: string;
  linkNotices: string;
  text: string;
  removedElements: number;
  blockedImages: number;
  allowedCidImages: number;
  allowedRemoteImages: number;
  linkWarnings: number;
}

type Attribute = { name: string; value: string };
type ParsedTag = { name: string; closing: boolean; selfClosing: boolean; attributes: Attribute[] };
type LinkFrame = { hostname: string; textStart: number; warnings: string[] };
type Frame = { outputName?: string; name: string; emitted: boolean; link?: LinkFrame };

const allowedTags = new Set([
  'p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'span',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a',
  'hr', 'font', 'center', 'html', 'body', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'
]);
const voidTags = new Set(['br', 'hr']);
const suppressedTags = new Set(['script', 'title', 'style', 'iframe', 'frame', 'frameset', 'form', 'object', 'embed', 'svg', 'math']);
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

function safeRemoteImageUrl(value: string): string | null {
  const safe = safeExternalUrl(value);
  if (!safe) return null;
  try {
    const parsed = new URL(safe);
    return parsed.protocol === 'https:' ? safe : null;
  } catch {
    return null;
  }
}

function isIpHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, '');
  return /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(normalized) || normalized.includes(':');
}

function displayedHostname(value: string): string | null {
  const normalized = value.trim().replaceAll(/\s+/gu, '');
  if (!normalized || normalized.length > 512 || !/[.:]/u.test(normalized)) return null;
  const candidate = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalized) ? normalized : `https://${normalized}`;
  try {
    const parsed = new URL(candidate);
    return parsed.hostname ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function externalLinkFrame(href: string, textStart: number): LinkFrame | undefined {
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    const hostname = parsed.hostname.toLowerCase();
    const warnings: string[] = [];
    if (parsed.protocol === 'http:') warnings.push('不安全 HTTP');
    if (hostname.includes('xn--')) warnings.push('Punycode 域名');
    if (isIpHostname(hostname)) warnings.push('IP 地址');
    if (parsed.username || parsed.password) warnings.push('包含用户信息');
    return { hostname, textStart, warnings };
  } catch {
    return undefined;
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

function presentationAttributes(attributes: Attribute[], tag: string): string {
  const values = mapAttributes(attributes);
  let output = '';
  const classes = (values.get('class') ?? '').split(/\s+/u).map(emailCssIdentifier).filter(Boolean);
  if (['html', 'body', 'font', 'center'].includes(tag)) classes.push(`fm-tag-${tag}`);
  if (classes.length) output += ` class="${classes.join(' ')}"`;
  const id = emailCssIdentifier(values.get('id') ?? '');
  if (id) output += ` id="${id}"`;
  const legacy: string[] = [];
  const color = values.get(tag === 'font' ? 'color' : 'bgcolor');
  if (color) legacy.push(`${tag === 'font' ? 'color' : 'background-color'}:${color}`);
  if (tag === 'font' && values.get('face')) legacy.push(`font-family:${values.get('face')}`);
  if (tag === 'center') legacy.push('text-align:center');
  const style = sanitizeEmailInlineCss([...legacy, values.get('style') ?? ''].join(';'));
  if (style) output += ` style="${escapeAttribute(style)}"`;
  for (const name of ['width', 'height', 'cellpadding', 'cellspacing', 'border']) {
    const value = values.get(name);
    if (value && /^\d{1,4}%?$/u.test(value)) output += ` ${name}="${value}"`;
  }
  for (const name of ['align', 'valign', 'dir']) {
    const value = values.get(name)?.toLowerCase();
    const valid = name === 'align' ? ['left', 'center', 'right', 'justify'] : name === 'valign' ? ['top', 'middle', 'bottom', 'baseline'] : ['ltr', 'rtl', 'auto'];
    if (value && valid.includes(value)) output += ` ${name}="${value}"`;
  }
  if (values.get('role') === 'presentation') output += ' role="presentation"';
  return output;
}

export function sanitizeHtml(input: string, options: SafeHtmlSanitizerOptions = {}): SafeHtmlResult {
  const limits = { ...SAFE_HTML_DEFAULT_LIMITS, ...options };
  const inputBytes = byteLength(input);
  if (inputBytes > limits.maxInputBytes) {
    throw new SafeHtmlError('HTML_INPUT_TOO_LARGE', 'HTML 正文超过大小限制。', { limit: limits.maxInputBytes, actual: inputBytes });
  }

  let html = '';
  let styles = '';
  let linkNotices = '';
  let stylesBytes = 0;
  let linkNoticeBytes = 0;
  let text = '';
  let position = 0;
  let nodes = 0;
  let removedElements = 0;
  let blockedImages = 0;
  let allowedCidImages = 0;
  let allowedRemoteImages = 0;
  let linkWarnings = 0;
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
    const actual = byteLength(next) + stylesBytes + linkNoticeBytes;
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
  const closeFrame = (frame: Frame) => {
    if (!frame.emitted || voidTags.has(frame.name)) return;
    append(`</${frame.outputName ?? frame.name}>`);
    if (!frame.link) return;
    if (options.decorateLinks !== false) {
      const label = text.slice(frame.link.textStart);
      const visibleHostname = displayedHostname(label);
      const targetHostname = frame.link.hostname;
      const mentionedHostnames = [...label.matchAll(/https?:\/\/[^\s/?#<>]+/giu)].map(([url]) => displayedHostname(url));
      const warnings = [...frame.link.warnings];
      if ((visibleHostname && visibleHostname !== frame.link.hostname) || mentionedHostnames.some((hostname) => hostname && hostname !== targetHostname)) warnings.push('显示文本与目标不一致');
      const warning = warnings.length
        ? ` <span class="fm-link-warning" aria-label="链接风险：${escapeAttribute(warnings.join('、'))}">⚠ ${escapeText(warnings.join('、'))}</span>`
        : '';
      const annotation = ` <span class="fm-link-target" aria-label="链接目标域名 ${escapeAttribute(frame.link.hostname)}">[${escapeText(frame.link.hostname)}]</span>${warning}`;
      if (options.preserveStyles) {
        // Always disclose real targets outside sender CSS, which can hide or
        // change link labels. Keep annotations out of buttons/navigation rows.
        const notice = `<p>${annotation}</p>`;
        linkNotices += notice;
        linkNoticeBytes += byteLength(notice);
        append(''); // Include notices in the shared output budget.
      } else {
        append(annotation);
      }
      if (warnings.length) linkWarnings += 1;
    }
  };

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
        if (frame) closeFrame(frame);
      }
      continue;
    }

    if (suppressed()) {
      continue;
    }

    if (parsed.name === 'style' && options.preserveStyles) {
      // style is raw text, not HTML. Never pass its contents through the tag loop.
      const end = /<\/style\s*>/giu;
      end.lastIndex = position;
      const closing = end.exec(input);
      const source = input.slice(position, closing?.index ?? input.length);
      const media = firstAttribute(parsed.attributes, 'media')?.trim().toLowerCase();
      const css = sanitizeEmailStylesheet(!media || media === 'all' || media === 'screen' ? source : `@media ${media}{${source}}`);
      const cssBytes = byteLength(css);
      if (byteLength(html) + stylesBytes + linkNoticeBytes + cssBytes > limits.maxOutputBytes) {
        throw new SafeHtmlError('HTML_OUTPUT_TOO_LARGE', '清洗后的 HTML 正文超过大小限制。', { limit: limits.maxOutputBytes });
      }
      styles += css;
      stylesBytes += cssBytes;
      position = closing ? end.lastIndex : input.length;
      continue;
    }

    if (suppressedTags.has(parsed.name)) {
      removedElements += 1;
      stack.push({ name: parsed.name, emitted: false });
      checkDepth();
      continue;
    }

    const presentation = options.preserveStyles ? presentationAttributes(parsed.attributes, parsed.name) : '';

    if (parsed.name === 'img') {
      const source = firstAttribute(parsed.attributes, 'src');
      const alt = firstAttribute(parsed.attributes, 'alt') ?? '';
      const cid = source?.match(/^cid:(.+)$/iu)?.[1]?.trim();
      if (cid && options.resolveCidImage) {
        const mapped = safeMappedCidUrl(options.resolveCidImage(cid));
        if (mapped) {
          const altAttribute = alt ? ` alt="${escapeAttribute(alt)}"` : '';
          append(`<img src="${escapeAttribute(mapped)}"${altAttribute}${presentation}>`);
          allowedCidImages += 1;
          if (alt) appendPlainText(alt);
          continue;
        }
      }
      const remote = source ? safeRemoteImageUrl(source) : null;
      if (remote && options.allowRemoteImages) {
        const altAttribute = alt ? ` alt="${escapeAttribute(alt)}"` : '';
        append(`<img src="${escapeAttribute(remote)}"${altAttribute}${presentation} loading="lazy" referrerpolicy="no-referrer">`);
        allowedRemoteImages += 1;
        if (alt) appendPlainText(alt);
        continue;
      }
      blockedImages += 1;
      removedElements += 1;
      if (alt) appendText(alt);
      continue;
    }

    if (!allowedTags.has(parsed.name) || (!options.preserveStyles && ['html', 'body', 'font', 'center', 'hr'].includes(parsed.name))) {
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
      append(`<a href="${escapeAttribute(safeHref)}" target="_blank" rel="noopener noreferrer"${options.preserveStyles ? ` title="${escapeAttribute(safeHref)}"` : ''}${presentation}>`);
      stack.push({ name: parsed.name, emitted: true, link: externalLinkFrame(safeHref, text.length) });
      checkDepth();
      continue;
    }

    const attributes = mapAttributes(parsed.attributes);
    let serializedAttributes = presentation;
    if (parsed.name === 'th' || parsed.name === 'td') {
      for (const name of ['colspan', 'rowspan']) {
        const value = attributes.get(name);
        if (value && /^[1-9][0-9]{0,2}$/u.test(value)) serializedAttributes += ` ${name}="${value}"`;
      }
    }
    const outputName = ['html', 'body', 'center'].includes(parsed.name) ? 'div' : parsed.name === 'font' ? 'span' : parsed.name;
    append(`<${outputName}${serializedAttributes}>`);
    if (!voidTags.has(parsed.name) && !parsed.selfClosing) {
      stack.push({ name: parsed.name, outputName, emitted: true });
      checkDepth();
    }
  }

  while (stack.length) {
    const frame = stack.pop();
    if (frame) closeFrame(frame);
  }

  if (options.preserveStyles) {
    // HTML5 table repair/adoption can move nodes outside a string wrapper.
    // Normalize the already allowlisted fragment in the same <div> context
    // used by the reader before embedding it beside trusted notices.
    const context = defaultTreeAdapter.createElement('div', html5.NS.HTML, []);
    const fragment = parseFragment(context, html, { scriptingEnabled: false });
    // HTML5 repair can deepen self-closing non-void tags and add table nodes.
    // Walk iteratively before parse5's recursive serializer so the repaired
    // tree obeys the same safety limits and cannot overflow the call stack.
    const pending: Array<{ node: DefaultTreeAdapterTypes.Node; depth: number }> = [{ node: fragment, depth: 0 }];
    let repairedNodes = 0;
    while (pending.length) {
      const current = pending.pop()!;
      if (current.node !== fragment) repairedNodes += 1;
      if (repairedNodes > limits.maxNodes) {
        throw new SafeHtmlError('HTML_COMPLEXITY_LIMIT', 'HTML 正文结构过于复杂。', { limit: limits.maxNodes, actual: repairedNodes });
      }
      const depth = current.depth + ('tagName' in current.node ? 1 : 0);
      if (depth > limits.maxDepth) {
        throw new SafeHtmlError('HTML_NESTING_TOO_DEEP', 'HTML 正文嵌套层级过深。', { limit: limits.maxDepth, actual: depth });
      }
      if ('childNodes' in current.node) {
        for (const child of current.node.childNodes) pending.push({ node: child, depth });
      }
    }
    html = serialize(fragment);
    const actual = byteLength(html) + stylesBytes + linkNoticeBytes;
    if (actual > limits.maxOutputBytes) {
      throw new SafeHtmlError('HTML_OUTPUT_TOO_LARGE', '清洗后的 HTML 正文超过大小限制。', { limit: limits.maxOutputBytes, actual });
    }
  }

  return { html, styles, linkNotices, text, removedElements, blockedImages, allowedCidImages, allowedRemoteImages, linkWarnings };
}
