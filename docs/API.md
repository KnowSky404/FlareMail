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

Inbound list rows contain metadata and a short snippet but do not select or
return the stored inbound body. The full body is loaded through the owned
message detail route when the user opens a message. Ownership is checked on
both list and detail paths.

## Draft concurrency

Draft writes include `expectedUpdatedAt`, the version observed by the editor.
The server updates only when that version still matches. A stale write returns
HTTP `409` with a typed `DRAFT_CONFLICT` error and the current server draft
metadata/body needed to choose between server and local content. The client
keeps the local edit visible, shows both edit timestamps, and can explicitly
reload the server version or overwrite after the user chooses.

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

## Evidence boundary

Unit, D1 integration, isolated Playwright, and axe checks use local/fake
bindings and do not prove production delivery. Production deployment, remote
migration, real Resend calls, Email Routing, and real-mail smoke tests remain
explicit operator actions.
