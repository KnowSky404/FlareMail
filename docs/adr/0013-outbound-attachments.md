# ADR 0013: Persist outbound attachments in R2 before send

## Status

Accepted.

## Decision

Compose JSON contains attachment metadata only. Each owned draft upload sends a
raw request body that the Worker streams to an opaque, server-generated R2 key.
D1 stores the draft/message relation, safe display filename, MIME type, byte
count, SHA-256, state, and cleanup deadline. Draft attachment mutations use a
separate monotonic revision from text autosave.

Only `ready` objects can be sent. Send reloads and hashes every object, then a
guarded D1 batch inserts the sent message, transfers attachment relations, and
deletes the draft. The relation and R2 object survive provider rejection or an
unknown outcome, so a permitted retry uses the identical bytes and durable
idempotency key. Downloads are owner-scoped, integrity-checked, no-store, and
forced to attachment disposition.

## Limits and compensation

The product limit is 10 files, 8 MiB each, and 12 MiB total raw bytes. This
leaves room below Resend's 40 MB post-Base64 email limit and Workers isolate
memory while the provider request is serialized. Upload failure deletes the new
object where possible and leaves bounded failed metadata for retry/maintenance.
Draft attachment delete failure leaves `delete_pending` metadata until a
reviewed maintenance manifest proves the object is orphaned. Permanent trash
deletion first writes each R2 key to a durable cleanup queue in the same D1
transaction that removes its parent records, so an R2 failure retains both API
retry and maintenance evidence.

Cancelling an attachment ID creates a short-lived `delete_pending` reservation
when the upload row has not arrived yet. That tombstone and the attachment
revision prevent a late request from resurrecting a cancelled file. Forwarding
starts without source attachments; the user may explicitly include them, in
which case each owned download is checked and re-uploaded through the same
draft lifecycle under a fresh attachment ID.

R2 and D1 cannot share one transaction. Per-attempt random keys, checksums,
revision guards, and compensation prevent a losing request from deleting a
winning object or sending an unverified/stale attachment set.
The guarded send batch also compares the exact verified ready-ID set and rejects
any uploading or failed row inserted after preflight. Upload streams are counted
while being piped to R2 and abort on the first byte beyond the declared limit.
