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

## `/api/send` compatibility contract

`POST /api/send` is a compatibility adapter for the first-generation compose
client. It is still an authenticated workspace operation; it is not a public
Resend proxy. The adapter keeps `RESEND_API_KEY` server-side, applies the same
recipient/subject/body limits and rate limits as the workspace send route, and
uses `OUTBOUND_FROM_EMAIL` as the recommended sender setting. `MAIL_FROM` may be
supplied by an older deployment as a runtime compatibility alias; when both are
present they must match, or environment validation fails closed.

The minimum legacy request is:

```http
POST /api/send
Content-Type: application/json
Idempotency-Key: flaremail-legacy-client-20260823-001

{
  "to": "recipient@example.test",
  "subject": "Hello",
  "html": "<p>Hello from FlareMail</p>"
}
```

`to` may be a single address (the legacy shape); implementations may also
accept the current address-list form. `text`, `cc`, `bcc`, and RFC threading
fields are optional extensions. The server must reject an empty/invalid
recipient, an overlong subject/body, and malformed JSON. `Idempotency-Key` is
recommended for retryable clients; when it is absent, the server uses the
request correlation ID, so a later retry must reuse that ID to deduplicate the
logical send. A successful compatibility response retains the old fields (the
standard envelope also adds `ok`, `data`, and `requestId`):

```json
{
  "ok": true,
  "data": {
    "message": {
      "id": "sent-local-message-id",
      "deliveryProviderMessageId": "provider-message-id"
    },
    "metrics": {}
  },
  "success": true,
  "id": "provider-message-id",
  "sentAt": "2026-08-23T12:00:00.000Z",
  "messageId": "sent-local-message-id",
  "requestId": "correlation-id"
}
```

The `id` is a provider message ID, not proof of delivery. The standard `data`
payload remains the typed workspace message/metrics result used by the web UI;
the top-level fields preserve the small compatibility contract. Clients should
inspect the persisted `submitted`/`delivered` state. Errors use the normal private
`requestId`/field-error envelope where possible; they never include the API key,
raw message body, R2 key, or provider credential details. The application-level
limit is 10 send or retry attempts per authenticated user per 60-second fixed
window; HTTP `429` includes `Retry-After`. `400`, `401`, `409`, `429`, and `503`
retain their normal meaning and are safe for clients to retry only when the
response contract allows it.

### HTML safety boundary

The `html` field is email content, not trusted application markup. The adapter
must validate its UTF-8 size and treat it as an opaque payload for the provider;
it must never expose `RESEND_API_KEY` to the browser or interpolate the request
into a page with Svelte `{@html}`. Any preview, sent-message detail, or inbound
message display goes through the server sanitizer and the sandboxed HTML route:

- scripts, event-handler attributes, forms, frames, SVG, `javascript:`/unsafe
  `data:` URLs, and unsafe CSS are removed;
- links receive safe target/rel handling and remote images are blocked by
  default, with an explicit per-viewer consent path;
- inline CID images are resolved only through an ownership-checked attachment
  route; attachment bytes and raw MIME are never embedded in JSON;
- the text view remains the safe fallback, and raw `.eml` download is an
  attachment response rather than executable HTML.

This boundary protects FlareMail's UI even when an outbound or inbound message
contains hostile HTML. It does not claim that a recipient's mail client will
render provider-delivered HTML identically; production testing must use a
dedicated mailbox and must not send secrets or personal data in fixtures.

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
