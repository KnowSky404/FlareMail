import { generate, lexer, parse, tokenize, tokenTypes, type CssNode, type List } from 'css-tree';

// Parse CSS with CSSTree, then retain presentation only. CSS resource loading
// stays disabled even after consenting to HTTPS <img> elements.
const properties = new Set(`
  color background background-color font font-family font-size font-style font-weight
  font-variant line-height letter-spacing word-spacing text-align text-decoration
  text-indent text-transform white-space word-break overflow-wrap vertical-align
  width min-width max-width height min-height max-height margin margin-top margin-right
  margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left
  border border-top border-right border-bottom border-left border-width border-style
  border-color border-top-width border-right-width border-bottom-width border-left-width
  border-top-style border-right-style border-bottom-style border-left-style
  border-top-color border-right-color border-bottom-color border-left-color border-radius
  border-collapse border-spacing table-layout caption-side empty-cells display
  list-style-type list-style-position
`.trim().split(/\s+/u));
const functions = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'calc', 'min', 'max', 'clamp']);
const simpleIdentifier = /^[a-zA-Z_][a-zA-Z0-9_-]*$/u;

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
    // Only permit literal tokens and a small set of numeric/color functions.
    const safeValue = (value: CssNode, depth = 0): boolean => {
      if (depth > 16) return false;
      if (value.type === 'Function') {
        return functions.has(value.name.toLowerCase()) && !value.children.some((child) => !safeValue(child, depth + 1));
      }
      if (value.type === 'Value') return !value.children.some((child) => !safeValue(child, depth + 1));
      return ['Identifier', 'Number', 'Dimension', 'Percentage', 'Hash', 'String', 'Operator', 'WhiteSpace'].includes(value.type);
    };
    if (!safeValue(node.value) || !lexer.matchProperty(property, node.value).matched) return;
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
        value += ['html', 'body', 'font', 'center'].includes(name) ? `.fm-tag-${name}` : name;
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
