# ADR 0012: Rebuildable owner-scoped FTS5 search

Status: accepted

## Context

Mailbox search previously expanded one user string into leading-wildcard
`LIKE` predicates across multiple columns. Besides forcing scans, D1 limits a
`LIKE` pattern to 50 UTF-8 bytes, so the 200-character UI contract was unsafe
for CJK, emoji and combining text. Search must cover inbound mail, sent mail
and drafts without placing raw MIME, full R2 bodies, attachment bytes, BCC or
secrets in D1.

## Decision

`workspace_search_documents` is the rebuildable source projection for search.
It stores the owner, canonical entity identity and byte-bounded From, To, CC,
subject, body and label text. Canonical mail tables remain the business source
of truth. Triggers on canonical inserts, relevant updates and deletes maintain
the projection; external-content FTS triggers keep `workspace_search_fts` in
sync with projection row IDs.

The query parser emits a data-only AST. A server compiler supplies every FTS
operator and column name from fixed whitelists, quotes values as phrases, and
passes the complete `MATCH` expression as one bound parameter. Flags, dates,
attachment existence and delivery status remain ordinary bound relational
predicates. BCC is intentionally excluded.

Search keeps the existing stable timestamp/entity cursor. FTS `snippet()` runs
in an inner query and returns private-use text delimiters; an outer window
query calculates the exact first-page total. Svelte renders delimited segments
as text and `<mark>` nodes, never as HTML. The legacy byte-safe LIKE builder is
retained only for explicitly chosen short fallback paths, not ordinary search.

## Repair, backup and restore

`bun run search:index -- --mode verify` is read-only and local by default. It
reports canonical, projected, missing and orphan counts. A reviewed
`--mode rebuild --apply` repairs projections and rebuilds FTS5.

D1 logical export does not support virtual tables. Managed D1 backups are the
default production backup. The explicit maintenance-window export workflow
temporarily removes only the FTS virtual table and its projection triggers,
keeps `workspace_search_documents`, exports canonical data, recreates the
virtual layer and rebuilds it. Remote and mutating modes both require explicit
flags; the application never initiates them.

## Consequences

- Search cost scales with FTS terms instead of leading-wildcard scans.
- Projection drift is observable and repairable without reading R2 or losing
  canonical mail.
- Writes pay trigger/index maintenance cost for bounded text only.
- Backup procedures must account for D1's virtual-table export limitation.
