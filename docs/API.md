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
text body and an opaque `bodyRevision`. Draft writes include `expectedUpdatedAt`,
the version observed by the editor, and echo `bodyRevision` after a canonical
body write. A client must present that revision before changing a tiered body;
an edit based only on a list projection returns `DRAFT_BODY_RELOAD_REQUIRED`.

The server updates only when that version still matches. A stale write returns
HTTP `409` with a typed `DRAFT_CONFLICT` error containing only `draftId` and
`updatedAt`. The client keeps the local edit visible and explicitly fetches the
owned current draft if the user chooses the server version; error envelopes do
not reflect a mail body.

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
operation is ownership-preflighted and safe to retry; if R2 is unavailable the
D1 rows remain intact.

`POST /api/workspace/trash` with `{ "action": "empty" }` permanently deletes
all owned trash items up to the bounded batch size. Expired trash is reported
by `scripts/maintenance.ts --trash-retention-days 30` in dry-run mode; the
maintenance command does not perform remote destructive trash cleanup.

## Evidence boundary

Unit, D1 integration, isolated Playwright, and axe checks use local/fake
bindings and do not prove production delivery. Production deployment, remote
migration, real Resend calls, Email Routing, and real-mail smoke tests remain
explicit operator actions.
