import type { DeliveryStatus } from './types';

export const SEARCH_QUERY_LIMITS = Object.freeze({
  maxUtf8Bytes: 8_192,
  maxTokens: 100
});

export type SearchIsFilter = 'unread' | 'starred' | 'archived' | 'trash';

export interface MailSearchQuery {
  /** Normalized terms from unqualified input, never an FTS expression. */
  terms: string[];
  filters: {
    from: string[];
    to: string[];
    cc: string[];
    subject: string[];
    is: SearchIsFilter[];
    hasAttachment: boolean;
    after: string[];
    before: string[];
    status: DeliveryStatus[];
    label: string[];
  };
}

export type SearchQueryErrorCode =
  | 'input_too_large'
  | 'too_many_tokens'
  | 'malformed_quotes'
  | 'unknown_operator'
  | 'missing_value'
  | 'invalid_value'
  | 'invalid_date'
  | 'invalid_status';

export class SearchQueryParseError extends Error {
  readonly code: SearchQueryErrorCode;
  readonly position?: number;

  constructor(code: SearchQueryErrorCode, position?: number) {
    super(`Invalid search query (${code}).`);
    this.name = 'SearchQueryParseError';
    this.code = code;
    this.position = position;
  }
}

const operators = new Set(['from', 'to', 'cc', 'subject', 'is', 'has', 'after', 'before', 'status', 'label']);
const isValues = new Set<SearchIsFilter>(['unread', 'starred', 'archived', 'trash']);
const deliveryStatuses = new Set<DeliveryStatus>([
  'draft', 'queued', 'submitting', 'submitted', 'sent', 'delivered', 'delayed',
  'bounced', 'failed', 'complained', 'suppressed'
]);

type Token = { value: string; raw: string; position: number };

function fail(code: SearchQueryErrorCode, position?: number): never {
  throw new SearchQueryParseError(code, position);
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/u.test(input[i]!)) i++;
    if (i >= input.length) break;
    const position = i;
    let value = '';
    let quoted = false;
    let raw = '';
    while (i < input.length && (quoted || !/\s/u.test(input[i]!))) {
      const char = input[i]!;
      raw += char;
      if (char === '"') {
        quoted = !quoted;
        i++;
        continue;
      }
      if (char === '\\') {
        i++;
        if (i >= input.length) fail('malformed_quotes', i - 1);
        const escaped = input[i]!;
        raw += escaped;
        value += escaped;
        i++;
        continue;
      }
      value += char;
      i++;
    }
    if (quoted) fail('malformed_quotes', position);
    tokens.push({ value, raw, position });
    if (tokens.length > SEARCH_QUERY_LIMITS.maxTokens) fail('too_many_tokens', position);
  }
  return tokens;
}

function addUnique<T>(items: T[], value: T): void {
  if (!items.includes(value)) items.push(value);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

/** Parse the provider-independent search language into a safe, data-only AST. */
export function parseMailSearchQuery(input: string): MailSearchQuery {
  if (new TextEncoder().encode(input).byteLength > SEARCH_QUERY_LIMITS.maxUtf8Bytes) fail('input_too_large');
  const terms: string[] = [];
  const filters: MailSearchQuery['filters'] = {
    from: [], to: [], cc: [], subject: [], is: [], hasAttachment: false,
    after: [], before: [], status: [], label: []
  };

  for (const token of tokenize(input)) {
    const colon = token.value.indexOf(':');
    if (colon < 0) {
      if (token.value.length > 0) addUnique(terms, token.value.normalize('NFC'));
      continue;
    }
    const operator = token.value.slice(0, colon).toLowerCase();
    const value = token.value.slice(colon + 1);
    if (!operators.has(operator)) fail('unknown_operator', token.position);
    if (value.length === 0) fail('missing_value', token.position);
    if (operator === 'has') {
      if (value !== 'attachment') fail('invalid_value', token.position);
      filters.hasAttachment = true;
    } else if (operator === 'is') {
      if (!isValues.has(value as SearchIsFilter)) fail('invalid_value', token.position);
      addUnique(filters.is, value as SearchIsFilter);
    } else if (operator === 'after' || operator === 'before') {
      if (!validDate(value)) fail('invalid_date', token.position);
      addUnique(filters[operator], value);
    } else if (operator === 'status') {
      if (!deliveryStatuses.has(value as DeliveryStatus)) fail('invalid_status', token.position);
      addUnique(filters.status, value as DeliveryStatus);
    } else {
      const field = operator as 'from' | 'to' | 'cc' | 'subject' | 'label';
      addUnique(filters[field], value.normalize('NFC'));
    }
  }
  return { terms, filters };
}
