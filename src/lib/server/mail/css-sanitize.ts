import { generate, lexer, parse, tokenize, tokenTypes, type CssNode, type List } from 'css-tree';

// Parse CSS with CSSTree, then retain presentation only. CSS resource loading
// stays disabled even after consenting to HTTPS <img> elements.
const properties = new Set(`
  color background background-color font font-family font-size font-style font-weight
  font-variant line-height letter-spacing word-spacing text-align text-decoration
  text-indent text-transform white-space word-break overflow-wrap vertical-align
  box-sizing width min-width max-width height min-height max-height margin margin-top margin-right
  margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left
  border border-top border-right border-bottom border-left border-width border-style
  border-color border-top-width border-right-width border-bottom-width border-left-width
  border-top-style border-right-style border-bottom-style border-left-style
  border-top-color border-right-color border-bottom-color border-left-color border-radius
  border-collapse border-spacing table-layout caption-side empty-cells display
  list-style-type list-style-position
`.trim().split(/\s+/u));
const functions = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark', 'calc', 'min', 'max', 'clamp',
  'linear-gradient', 'radial-gradient', 'conic-gradient',
  'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient']);
const simpleIdentifier = /^[a-zA-Z_][a-zA-Z0-9_-]*$/u;

/** WHATWG legacy color parsing for bgcolor, body text and font color.
 * https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#rules-for-parsing-a-legacy-colour-value
 * The result is a named color or hex color, never arbitrary CSS tokens.
 */
export function sanitizeEmailLegacyColor(input: string): string | null {
  if (!input) return null;
  let value = input.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, '');
  if (value.toLowerCase() === 'transparent') return null;
  if (/^[a-z]+$/iu.test(value) && lexer.matchType('named-color', value).matched) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/iu.test(value)) return value.toLowerCase();
  value = value.replace(/[\u{10000}-\u{10ffff}]/gu, '00').slice(0, 128).replace(/^#/u, '').replace(/[^0-9a-f]/giu, '0');
  while (!value.length || value.length % 3) value += '0';
  let length = value.length / 3;
  let components = [value.slice(0, length), value.slice(length, 2 * length), value.slice(2 * length)];
  if (length > 8) {
    components = components.map((component) => component.slice(-8));
    length = 8;
  }
  while (length > 2 && components.every((component) => component.startsWith('0'))) {
    components = components.map((component) => component.slice(1));
    length -= 1;
  }
  return '#' + components.map((component) => component.slice(0, 2).padStart(2, '0')).join('').toLowerCase();
}

export function emailCssIdentifier(value: string): string | null {
  return simpleIdentifier.test(value) ? `fm-user-${value}` : null;
}

function boundedSource(source: string): boolean {
  if (/[<\\\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(source)) return false;
  // CSSTree's non-recursive tokenizer bounds nesting before AST parsing,
  // without counting punctuation inside comments, URLs or font-family strings.
  let depth = 0;
  let valid = true;
  tokenize(source, (type) => {
    if ([tokenTypes.Function, tokenTypes.LeftParenthesis, tokenTypes.LeftSquareBracket, tokenTypes.LeftCurlyBracket].includes(type)) depth += 1;
    if ([tokenTypes.RightParenthesis, tokenTypes.RightSquareBracket, tokenTypes.RightCurlyBracket].includes(type)) depth -= 1;
    if (depth > 32 || depth < 0) valid = false;
  });
  return valid && depth === 0;
}

function declarations(children: List<CssNode>): string {
  const output: string[] = [];
  children.forEach((node) => {
    if (node.type !== 'Declaration') return;
    const property = node.property.toLowerCase();
    if (!properties.has(property) || node.value.type !== 'Value') return;
    // Only permit literal tokens and known numeric, color and gradient functions.
    const safeValue = (value: CssNode, depth = 0): boolean => {
      if (depth > 16) return false;
      if (value.type === 'Function') {
        return functions.has(value.name.toLowerCase()) && !value.children.some((child) => !safeValue(child, depth + 1));
      }
      if (value.type === 'Value') return !value.children.some((child) => !safeValue(child, depth + 1));
      return ['Identifier', 'Number', 'Dimension', 'Percentage', 'Hash', 'String', 'Operator', 'WhiteSpace'].includes(value.type);
    };
    if (!safeValue(node.value)) {
      // A blocked background image must not discard the sender's explicit
      // fallback color and leave retained light text unreadable. Only extract
      // a top-level color from a syntactically valid background shorthand.
      if (property === 'background' && lexer.matchProperty(property, node.value).matched) {
        const colors = node.value.children.toArray().filter((part) =>
          safeValue(part) && lexer.matchProperty('background-color', generate(part)).matched);
        if (colors.length === 1) output.push(`background-color:${generate(colors[0])}${node.important ? '!important' : ''}`);
      }
      return;
    }
    if (!lexer.matchProperty(property, node.value).matched) return;
    output.push(`${property}:${generate(node.value)}${node.important ? '!important' : ''}`);
  });
  return output.join(';');
}

export function sanitizeEmailInlineCss(source: string): string {
  if (!boundedSource(source)) return '';
  try {
    const ast = parse(source, { context: 'declarationList' });
    return ast.type === 'DeclarationList' ? declarations(ast.children) : '';
  } catch {
    return '';
  }
}

function scopedSelectors(node: CssNode): string {
  if (node.type !== 'SelectorList') return '';
  const output: string[] = [];
  node.children.forEach((selector) => {
    if (selector.type !== 'Selector') return;
    let valid = true;
    let value = '';
    selector.children.forEach((part) => {
      if (part.type === 'ClassSelector' || part.type === 'IdSelector') {
        const name = emailCssIdentifier(part.name);
        if (!name) valid = false;
        else value += `${part.type === 'ClassSelector' ? '.' : '#'}${name}`;
      } else if (part.type === 'TypeSelector' && /^(?:[a-zA-Z][a-zA-Z0-9-]*|\*)$/u.test(part.name)) {
        const name = part.name.toLowerCase();
        value += name === 'html' || name === 'body' ? `fm-email-${name}` : name;
      } else if (part.type === 'Combinator' && [' ', '>', '+', '~'].includes(part.name)) {
        value += part.name;
      } else if (part.type === 'PseudoClassSelector' && !part.children && ['first-child', 'last-child', 'only-child', 'empty'].includes(part.name)) {
        value += `:${part.name}`;
      } else {
        valid = false;
      }
    });
    if (valid && value) output.push(`.fm-email-content ${value}`);
  });
  return output.join(',');
}

function rules(children: List<CssNode>, depth = 0): string {
  if (depth > 4) return '';
  let output = '';
  children.forEach((node) => {
    if (node.type === 'Rule' && node.prelude) {
      const selector = scopedSelectors(node.prelude);
      const body = declarations(node.block.children);
      if (selector && body) output += `${selector}{${body}}`;
    } else if (node.type === 'Atrule' && node.name.toLowerCase() === 'media' && node.prelude && node.block) {
      const query = generate(node.prelude);
      // Width-only queries support responsive mail without exposing device,
      // system-theme, or font probing through conditional resource requests.
      if (!/^(?:(?:only )?screen(?: and )?)?\((?:min|max)-width:\d+(?:\.\d+)?(?:px|em)\)(?: and \((?:min|max)-width:\d+(?:\.\d+)?(?:px|em)\))*$/iu.test(query)) return;
      const body = rules(node.block.children, depth + 1);
      if (body) output += `@media ${query}{${body}}`;
    }
  });
  return output;
}

export function sanitizeEmailStylesheet(source: string): string {
  source = source.replaceAll('<!--', '').replaceAll('-->', '');
  if (!boundedSource(source)) return '';
  try {
    const ast = parse(source);
    return ast.type === 'StyleSheet' ? rules(ast.children) : '';
  } catch {
    return '';
  }
}
