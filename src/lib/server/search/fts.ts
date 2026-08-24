import type { MailSearchHitField, MailSearchQuery } from '$lib/domain/mail';

export interface FtsSearchPlan {
  expression: string | null;
  hitFields: MailSearchHitField[];
}

const fieldColumns = Object.freeze({
  from: 'from_text',
  to: 'to_text',
  cc: 'cc_text',
  subject: 'subject_text',
  label: 'labels_text'
});

/**
 * Values are quoted inside an expression that is itself passed to MATCH as a
 * bound parameter. FTS operators, column names and grouping punctuation can
 * therefore only originate from this module's fixed whitelist.
 */
function phrase(value: string): string {
  return `"${value.normalize('NFC').replaceAll('"', '""')}"`;
}

function anyOf(values: string[], column?: string): string | null {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (!normalized.length) return null;
  const parts = normalized.map((value) => column ? `${column} : ${phrase(value)}` : phrase(value));
  return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
}

/** Compile the parser AST into a safe, bound FTS5 expression and UI metadata. */
export function buildFtsSearchPlan(search: MailSearchQuery): FtsSearchPlan {
  const clauses: string[] = [];
  const hitFields = new Set<MailSearchHitField>();
  const terms = anyOf(search.terms);
  if (terms) {
    clauses.push(terms);
    hitFields.add('all');
  }

  for (const field of ['from', 'to', 'cc', 'subject', 'label'] as const) {
    const clause = anyOf(search.filters[field], fieldColumns[field]);
    if (!clause) continue;
    clauses.push(clause);
    hitFields.add(field);
  }
  if (search.filters.is.length) hitFields.add('state');
  if (search.filters.hasAttachment) hitFields.add('attachment');
  if (search.filters.after.length || search.filters.before.length) hitFields.add('date');
  if (search.filters.status.length) hitFields.add('status');

  return {
    expression: clauses.length ? clauses.join(' AND ') : null,
    hitFields: [...hitFields]
  };
}
