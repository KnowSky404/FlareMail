# ADR 0011: Tier large mail bodies into R2

Status: accepted, 2026-08-19

## Context

Cloudflare D1 limits a row and an individual `TEXT`/`BLOB` value to 2 MB. A
JavaScript character count does not bound UTF-8 bytes, and an inbound MIME
message can contain both large text and HTML alternatives. Returning every
body in the mailbox snapshot also makes SSR and client memory grow with page
size.

## Decision

Migration `0012_body_objects.sql` adds an optional `body_object_id` to inbound,
sent, and draft rows plus the `mail_body_objects` lifecycle table.

- Canonical version-1 JSON contains `textBody` and `htmlBody` and is stored in
  R2 once its encoded envelope exceeds 256 KiB.
- Every object key contains a server-generated object ID and SHA-256 digest.
  The unique ID prevents a losing concurrent write from deleting another
  write with identical content.
- D1 retains at most 128 KiB of text, 64 KiB of HTML, and a 4 KiB snippet. Mail
  lists select no body; authenticated detail routes load canonical text lazily.
- Compose text is limited to 8 MiB of UTF-8. The canonical inbound envelope is
  limited to 32 MiB. If MIME decoding expands beyond that envelope limit, the
  original `.eml` remains the lossless R2 source while D1 stores bounded
  projections.
- An editor receives an opaque `bodyRevision` only after loading the canonical
  draft. The server refuses edits based on a truncated projection. Legacy
  clients may save metadata while preserving an unchanged canonical pointer.
- Reads verify owner, entity, stored size, and SHA-256 before decoding.
- Replaced and deleted objects enter `delete_pending`. The maintenance command
  remains dry-run by default, requires a reviewed R2 manifest for deletion,
  and removes metadata only after its object deletion succeeds.

Raw HTML is not returned by the general body endpoint. Safe HTML reading uses a
separate sanitizer and sandbox boundary.

## Consequences

Body persistence is a D1/R2 compensated workflow rather than one atomic
transaction. R2 keys are per-attempt, failed pre-pointer writes are removed,
and superseded objects are delayed for maintenance. An operator must apply
migration 0012 before code that writes body pointers. Existing null pointers
remain readable from legacy inline columns.
