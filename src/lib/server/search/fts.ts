import type { MailSearchHitField, MailSearchQuery } from '$lib/domain/mail';

export interface FtsSearchPlan {
  /** Full-text filters other than labels; persisted labels live outside the FTS projection. */
  expression: string | null;
  /** Legacy labels remain searchable through their existing FTS column. */
  labelExpression: string | null;
  hitFields: MailSearchHitField[];
}

const fieldColumns = Object.freeze({
  from: 'from_text',
  to: 'to_text',
  cc: 'cc_text',
  subject: 'subject_text'
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

  for (const field of ['from', 'to', 'cc', 'subject'] as const) {
    const clause = anyOf(search.filters[field], fieldColumns[field]);
    if (!clause) continue;
    clauses.push(clause);
    hitFields.add(field);
  }
  const labelExpression = anyOf(search.filters.label, 'labels_text');
  if (labelExpression) hitFields.add('label');
  if (search.filters.is.length) hitFields.add('state');
  if (search.filters.hasAttachment !== null) hitFields.add('attachment');
  if (search.filters.after.length || search.filters.before.length) hitFields.add('date');
  if (search.filters.status.length) hitFields.add('status');

  return {
    expression: clauses.length ? clauses.join(' AND ') : null,
    labelExpression,
    hitFields: [...hitFields]
  };
}

type LabelSearchSource = 'message' | 'draft' | 'inbound';

/** Match legacy FTS labels or current Owner-owned user labels for one mail source. */
export function buildLabelSearchPredicate(
  search: MailSearchQuery, labelExpression: string | null, source: LabelSearchSource
): { sql: string; bindings: string[] } | null {
  if (!labelExpression) return null;
  const columns = {
    message: { owner: 'm.user_id', kind: 'workspace', id: 'm.id' },
    draft: { owner: 'd.user_id', kind: 'draft', id: 'd.id' },
    inbound: { owner: 'e.owner_user_id', kind: 'inbound', id: 'e.id' }
  }[source];
  const keys = search.filters.label.map((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und'));
  return {
    sql: `(search_document.id IN (
      SELECT rowid FROM workspace_search_fts WHERE workspace_search_fts MATCH ?
    ) OR EXISTS (
      SELECT 1 FROM mail_message_labels AS searched_label
      JOIN mail_labels AS named_label
        ON named_label.owner_user_id = searched_label.owner_user_id AND named_label.id = searched_label.label_id
      WHERE searched_label.owner_user_id = ${columns.owner}
        AND searched_label.message_kind = ? AND searched_label.message_id = ${columns.id}
        AND named_label.name_key IN (${keys.map(() => '?').join(', ')})
    ))`,
    bindings: [labelExpression, columns.kind, ...keys]
  };
}
