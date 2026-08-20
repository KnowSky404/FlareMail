# FlareMail workspace API

This document describes the current authenticated workspace contracts. Routes
return the standard typed JSON envelope and reject unauthenticated or
cross-owner requests without exposing mailbox existence.

## Workspace snapshot

`GET /api/workspace/session` returns the authenticated workspace snapshot. The response
contains `activeFolder`, `mailboxPages`, and `metrics`.

- `activeFolder` is `inbox`, `sent`, `drafts`, or `archive`.
- Only the active folder's first page is loaded during the initial snapshot.
- `metrics` is fetched once for the snapshot and is not repeated per folder.
- `metrics` contains global mailbox counts plus global outbound aggregates:
  `queuedCount`, `delayedCount`, `failedCount`, `bouncedCount`,
  `complainedCount`, and `staleDeliveryCount`. These values cover the owned
  workspace, not only the currently loaded page. A submission is stale after
  15 minutes in `submitting` state.
- Changing folder requests that folder's page lazily. `archive` is a mailbox
  section backed by inbox rows with `archived_at`, not a persisted `folder`
  value.
- Logging out clears the client snapshot, metrics, selected message, detail
  cache, and mailbox pages before another user can log in.

## Mailbox pages

`GET /api/workspace/mailbox?folder=inbox|sent|drafts|archive&limit=...&cursor=...`
returns a page with an opaque cursor. `q` and `filter` are optional server-side
query parameters; a cursor is only valid for the same folder, section, query,
and filter.

Mailbox list rows contain metadata and a short snippet but do not select or
return stored inbound, sent, or draft bodies. Inbound text is loaded through
the owned message detail route. Workspace sent text is loaded through
`GET /api/workspace/messages/:id/body`; the response never contains raw HTML.
Ownership is checked on every list and detail path.

## Response and runtime errors

Authenticated JSON routes use one correlation ID in the response body and the
`X-Request-ID` header:

```json
{
  "ok": false,
  "error": {
    "code": "D1_UNAVAILABLE",
    "message": "工作区数据服务暂时不可用。",
    "retryable": true
  },
  "requestId": "correlation-id"
}
```

Runtime failures are classified as `CONFIG_INVALID`,
`AUTHENTICATION_UNAVAILABLE`, `SCHEMA_NOT_READY`, `D1_UNAVAILABLE`,
`R2_UNAVAILABLE`, `NETWORK_FAILURE`, or `INTERNAL_ERROR`. Server logs contain
the correlation ID and safe classification metadata, never request bodies,
mail content, bindings, credentials, or raw exception messages. HTML page loads
return a typed unavailable view with retry and the read-only health link; they
do not turn a storage or schema failure into the login page.

`GET /api/health` is the unauthenticated readiness endpoint. It returns HTTP
`200` only when production configuration is valid, every required table exists,
and `workspace_schema_metadata` equals the exact application schema version.
Otherwise it returns HTTP `503` with a typed safe error and correlation ID.

## Draft concurrency

`GET /api/workspace/drafts/:id` returns the current owned draft with its full
text body, an opaque `bodyRevision`, visible attachment lifecycle summaries, and an integer
`attachmentRevision`. Draft writes include `expectedUpdatedAt`,
the version observed by the editor, and echo `bodyRevision` after a canonical
body write. A client must present that revision before changing a tiered body;
an edit based only on a list projection returns `DRAFT_BODY_RELOAD_REQUIRED`.

The server updates only when that version still matches. A stale write returns
HTTP `409` with a typed `DRAFT_CONFLICT` error containing only `draftId` and
`updatedAt`. The client keeps the local edit visible and explicitly fetches the
owned current draft if the user chooses the server version; error envelopes do
not reflect a mail body.

## Outbound attachments

Attachment bytes never enter the compose JSON or D1. The browser computes a
SHA-256 digest, then sends the raw request body to
`PUT /api/workspace/drafts/:draftId/attachments/:attachmentId` with `filename`,
`size`, and `attachmentRevision` query parameters plus `Content-Type` and
`X-FlareMail-SHA256` headers. The Worker streams that body to a server-generated
`outbound/v1/...` R2 key that contains no user filename. The response returns
the next attachment revision and the complete visible lifecycle summary list.
`failed` and interrupted `uploading` rows remain visible after refresh so the
client can retry or remove them; `delete_pending` rows are hidden and do not
block sending while maintenance completes cleanup.

`PATCH` on the same route accepts `{ filename, attachmentRevision }`; `DELETE`
accepts `attachmentRevision` in the query. Every operation checks draft owner,
uses optimistic concurrency, sanitizes the display filename, and keeps failed
or interrupted objects in a bounded cleanup lifecycle. Limits are 10 files,
8 MiB per file, and 12 MiB total raw bytes. The total leaves headroom below
Resend's 40 MB post-Base64 message limit and the Worker serialization budget.
The server validates a present `Content-Length` and always wraps the request
stream in a byte-counting transform, so chunked or misleading uploads abort as
soon as they exceed the declared per-file limit.

A draft send must present the current `attachmentRevision`. Before persistence,
the server reloads every ready R2 object and verifies its size and SHA-256. The
sent message insert, attachment relation transfer, and draft deletion then run
in one guarded D1 batch. Provider failure or an unknown result does not delete
the attachment: same-key delivery retries reload and verify the same persisted
objects. `GET /api/workspace/messages/:id/body` includes sent attachment
summaries, and the owned attachment route forces safe download headers after a
fresh integrity check.

## Inbound attachment downloads

Email Routing ingest computes SHA-256 from the already bounded parsed bytes and
persists the same lowercase digest in R2 put metadata and the owned D1
attachment row. The download route first resolves session, message,
relation, attachment ID, and owner scope. It then requires the object, exact
size, and, for new rows, a matching SHA-256 before returning any bytes.

Missing, size-mismatched, and checksum-mismatched objects return controlled
typed errors without an R2 key, filename, object bytes, or storage exception.
Responses retain `no-store`, `nosniff`, safe `Content-Disposition`, and a
bounded content type. Historical checksum-null rows use actual-byte size
verification and the degraded integrity event until an operator runs the
bounded repair workflow; a download never performs bulk repair.

## Mailbox mutations

`POST /api/workspace/mailbox/mutate`

```json
{
  "action": "archive|unarchive|read|unread|star|unstar",
  "ids": ["optional-message-id"],
  "threadKeys": ["optional-owned-thread-key"]
}
```

The route deduplicates direct IDs and thread keys, resolves thread keys on the
server, and applies a maximum of 100 resolved message IDs. Every target is
ownership-checked before any write. Unknown, cross-owner, mixed-folder, or
partially invalid requests fail without a partial mutation.

The write is one D1 `batch()` transaction. Read/star actions preserve the
message's persisted folder. Archive and unarchive only operate on inbox-owned
rows and change `archived_at`; they never rewrite `folder` to manufacture an
archive folder. The response returns affected summaries, movement information,
updated metrics, and the server-resolved IDs.

## Mailbox search

`GET /api/workspace/mailbox` accepts `q`/`query` and executes the normalized
query through the owner-scoped D1 FTS5 projection. Free text and the following
operators are supported: `from:`, `to:`, `cc:`, `subject:`, `is:unread`,
`is:starred`, `is:archived`, `is:trash`, `has:attachment`, `after:YYYY-MM-DD`,
`before:YYYY-MM-DD`, `status:` and `label:`. Quotes group spaces. Unknown
operators, malformed quotes, dates and statuses return
`INVALID_SEARCH_QUERY`; no user input is interpolated as SQL or as an FTS
column name.

Search pages keep the normal opaque timestamp/id cursor. The first page also
returns `searchTotal` and `searchHitFields`; each result can include a bounded
`searchSnippet` whose private-use delimiters are rendered as text highlights,
never as HTML. BCC, raw MIME, attachment bytes and secrets are not searchable.

## Delivery retry

Retry is available only when the persisted delivery state is retryable
(`submitting`, `delayed`, or `failed`), the durable idempotency key is present,
the attempt has started, and the attempt remains inside the 24-hour provider
idempotency window. `queued`, `submitted`, `accepted`, delivered, and other
terminal states are not ordinary retry targets.

The UI and server use the same domain eligibility rule. The server additionally
rechecks ownership, message/delivery linkage, persisted key, attempt count, and
window before sending. A business rejection returns a typed conflict/error
response; an expired attempt requires delivery review rather than silently
creating a new provider idempotency key.

## Trash

`DELETE /api/workspace/messages/:id` is a soft delete. It keeps the owned
message, draft, or inbound state and records its deletion time; repeated
requests are idempotent. Normal mailbox lists and counts exclude these rows.

`GET /api/workspace/trash?limit=100` returns one ownership-scoped list across
workspace messages, drafts, and inbound messages. Each item includes its
`deletedAt` and `originalFolder` (`inbox`, `archive`, `sent`, or `drafts`).

`POST /api/workspace/trash/:id` restores an item to the persisted folder and
archive state. `DELETE /api/workspace/trash/:id` permanently deletes only an
owned trash item. Permanent deletion removes delivery status, attempts,
events, receipts, attachment/body metadata, and their owned R2 objects. The
operation is ownership-preflighted and safe to retry. It commits the owned D1
deletion before deleting R2 objects, so a storage failure cannot leave live D1
pointers to missing data. The same D1 transaction records every object in
`workspace_r2_cleanup_queue`; successful deletes mark those records completed
and retain the lifecycle evidence. `cleanupPending: true` means retry/backoff or
manual review remains. Claim tokens, leases, bounded attempts, canonical key
scope, and source ownership make later API or reviewed maintenance replay
idempotent.

`POST /api/workspace/trash` with `{ "action": "empty" }` permanently deletes
all owned trash items up to the bounded batch size. Expired trash is reported
by `scripts/maintenance.ts --trash-retention-days 30` in dry-run mode; the
maintenance command does not perform remote destructive trash cleanup.

## Evidence boundary

Unit, D1 integration, isolated Playwright, and axe checks use local/fake
bindings and do not prove production delivery. Production deployment, remote
migration, real Resend calls, Email Routing, and real-mail smoke tests remain
explicit operator actions.
