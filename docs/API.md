# FlareMail workspace API

This document describes the current authenticated workspace contracts. Routes
return the standard typed JSON envelope and reject unauthenticated or
cross-owner requests without exposing mailbox existence.

## Workspace snapshot

`GET /api/workspace/session` returns the authenticated workspace snapshot. The response
contains `activeFolder`, `mailboxPages`, `metrics`, and `mailIdentityOptions`.

- `activeFolder` is `inbox`, `sent`, `drafts`, or `archive`.
- Only the active folder's first page is loaded during the initial snapshot.
- `metrics` is fetched once for the snapshot and is not repeated per folder.
- `metrics` contains mailbox counts and outbound aggregates for the full Owner
  when no identity filter is selected, or for the selected domain/address when
  one is active:
  `queuedCount`, `delayedCount`, `failedCount`, `bouncedCount`,
  `complainedCount`, and `staleDeliveryCount`. These values cover the owned
  selected scope, not only the currently loaded page. A submission is stale
  after 15 minutes in `submitting` state.
- `mailIdentityOptions` contains the Owner's configured domains and address
  choices. Address options expose lifecycle/send readiness and the selected
  default, never Cloudflare tokens or remote API details.
- Changing folder requests that folder's page lazily. `archive` is a mailbox
  section backed by inbox rows with `archived_at`, not a persisted `folder`
  value.
- Logging out clears the client snapshot, metrics, selected message, detail
  cache, and mailbox pages before another user can log in.

## Mailbox pages

`GET /api/workspace/mailbox?folder=inbox|sent|drafts|archive&limit=...&cursor=...`
returns a page with an opaque cursor. `q`, `filter`, and `identity` are optional
server-side query parameters; `identity` accepts `domain:<owned-id>` or
`address:<owned-id>`. A cursor is only valid for the same folder, section,
query, filter, delivery status, and identity. The selected scope applies before
pagination to inbound mail, sent mail, drafts, search results, and metrics.
Unknown or foreign identity IDs are rejected; identity filters do not rely on
the current browser page.

Mailbox list rows contain metadata and a short snippet but do not select or
return stored inbound, sent, or draft bodies. Inbound text is loaded through
the owned message detail route. Workspace sent text is loaded through
`GET /api/workspace/messages/:id/body`; the response never contains raw HTML.
Ownership is checked on every list and detail path.

Inbound `email_messages."to"` is the Cloudflare Email Routing envelope
recipient. MIME `To` and `Cc` remain separate parsed headers, and raw
`Delivered-To` remains a separate header snapshot. The detail view displays
the actual envelope destination independently from the message's To header.

## Managed domains and addresses

`GET /api/workspace/mail-identities` returns only the authenticated Owner's
configured domains and addresses. Domain enrollment is an operator-controlled
configuration step (`bun run mail:domain:configure`) that records the exact
domain-to-zone and Worker mapping; the browser cannot choose an arbitrary zone,
Worker, API origin, or Cloudflare endpoint. The response also includes boolean
provider-configuration flags; it never returns a token or key.

- `POST /api/workspace/mail-identities` creates an address in an already
  configured domain. The Worker creates an exact Email Routing rule and stores
  the returned rule ID. Repeated or concurrent requests reconcile the same
  address operation; an uncertain remote result remains visible as pending or
  error for a later check/retry.
- `POST /api/workspace/mail-identities/domains/:domainId/check` reads that
  configured zone's exact rules and catch-all, and checks the domain-level
  Resend sending status. The two provider reads have separate expiring leases;
  a concurrent click or scheduled read returns an in-progress result instead
  of starting a duplicate request. The check has bounded provider timeouts.
  A matching Worker rule may be explicitly imported; a duplicate or same-name
  rule to another target is a conflict and is never overwritten automatically.
  Address results may be `busy` while another address operation owns its lease;
  that check result is discarded for that address. Route observations never
  change an address's `receive_enabled` preference. `deleted_absent` is a
  completed tombstone result, while `imported_preserved` is an expected
  preserved-rule result.
- `POST /api/workspace/mail-identities/:addressId` supports `disable`,
  `enable`, `import`, `restore`, `retry`, `enable_send`, `disable_send`, and
  `make_default`. Receive lifecycle and sending permission are separate.
- `DELETE /api/workspace/mail-identities/:addressId` requires
  `{ "confirm": "delete" }`. It closes local send/receive access and records a
  tombstone before remote rule cleanup. It does not delete historical mail,
  drafts, or R2 content. Before removing a FlareMail-owned rule it verifies the
  saved ID, API source, exact management marker, enabled literal recipient
  matcher, single Worker action, and full configured Worker target, then reads
  the rule set again immediately before DELETE. Imported rules are preserved.
  A rule changed externally returns a conflict and is left alone. Restore is
  allowed only after deletion is reconciled and no address operation lease is
  active; it verifies or recreates the route before enabling receiving. An
  active operation or unresolved deletion returns `MAIL_ADDRESS_OPERATION_CONFLICT`.

The [Cloudflare Email Routing Rules API](https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/)
documents deletion by rule ID without an ETag/version precondition. The final
read narrows the external-change window but cannot make the Cloudflare request
and D1 update atomic. Timeouts are reconciled with a read before a retry can
issue another DELETE.

The default unknown-recipient policy is `reject`. Optional `collect` is allowed
only for a configured domain whose read-only check confirms its catch-all
targets this Worker; collected messages retain the actual envelope address and
do not create a sendable identity. A healthy catch-all observation is normally
fresh for 24 hours. If the last check then fails with a transient Cloudflare
network, timeout, rate-limit, or upstream error, an already-confirmed explicit
`collect` domain may keep collecting for one additional bounded 24-hour grace.
This does not update the success timestamp. Permission/configuration errors,
missing credentials, an observed target mismatch, disabled domains, and
disabled/deleted explicit addresses do not receive that grace. Unknown domains
are never globally accepted. A previously disabled/deleted explicit address
is rejected before catch-all collection. Deleting this application's exact
rule cannot block an external Worker or forwarding catch-all that also matches
the domain.

The current [Email Routing Worker handler contract](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
documents `message.setReject()` for an explicit refusal but does not promise
automatic redelivery when a handler throws. FlareMail therefore does not rely
on throw-to-retry as a delivery guarantee. Inbound storage or D1 failures still
throw rather than being converted to a permanent reject; their redelivery
behavior must be verified against the deployed Cloudflare account separately.

## Scheduled provider health

The existing one-minute Worker Cron remains active for Telegram's durable
outbox. Mail health checks run in an independently caught scheduled task. Each
provider selects only due rows through indexed next-check fields and an
independent expiring D1 lease; one invocation checks at most one due domain per
provider. Cloudflare reads are capped at ten rules pages and a 12-second
provider deadline; Resend reads have a 10-second total deadline. No scheduler
path calls the Cloudflare create/delete API or changes address lifecycle,
send, or receive preferences.

Healthy provider checks schedule the next attempt 16–20 hours later with stable
per-domain jitter. Checks that observe a non-ready domain or route schedule a
six-hour review. Retryable API errors use jittered exponential backoff capped
at 20 hours; permission/configuration errors retry after six hours. Provider
success timestamps never advance on a timeout, 403, 429, invalid response, or
unknown result. A real Resend state such as `pending`, `failed`, `missing`, or
sending-disabled is stored as an observation with its actual check time and a
degraded state. Cloudflare and Resend timestamps/errors do not block one another.
Mail health refresh uses `CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN` when configured
and falls back to `CLOUDFLARE_EMAIL_ROUTING_TOKEN` for existing deployments.
The former needs read-only zone/routing access; address create/delete
operations still require the latter's edit permission.

`GET /api/readiness` is authenticated and includes per-domain provider state
(`fresh`, `stale`, `refreshing`, `degraded`, or `not_configured`), last success,
next scheduled check, last failure, safe error code, and catch-all observation
time. Public `GET /api/health` remains only `{ "ok": true }`.

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

`GET /api/health` is a minimal public liveness endpoint and returns only
`{ "ok": true }`; it does not read bindings or disclose deployment state.
`GET /api/readiness` is private and requires a valid workspace session. It
checks runtime configuration, the exact required schema version/tables, and
reports safe cleanup-queue counts and mail-domain health metadata. It never
returns provider credentials, zone IDs, message or address records. Failures
return a typed safe error and correlation ID without configuration values or
schema internals.

## Telegram notification API

Telegram routes are authenticated workspace operations and use the standard
`{ ok, data, requestId }` envelope with `cache-control: private, no-store`.
They never return the Bot token or Telegram chat ID and cannot select another
user's binding or delivery rows.

- `GET /api/workspace/notifications/telegram/settings` returns global enabled
  state, configuration/schema readiness, the current user's candidate/active
  binding state, privacy/summary switches, and a small recent-delivery list.
- `POST /api/workspace/notifications/telegram/bind` creates a 10-minute,
  one-time deep link. The token is returned only in that authenticated response
  and is stored only as a hash. An active binding must be explicitly unbound
  before it can be replaced.
- `POST /api/workspace/notifications/telegram/confirm` promotes the current
  candidate to an active but disabled binding.
- `PATCH /api/workspace/notifications/telegram/settings` accepts boolean
  `enabled`, `privacyMode`, and/or `summaryEnabled`. Enabling requires an
  active binding; `forwardingEnabled` and `INBOUND_NOTIFICATION_ENABLED` are
  separate legacy controls.
- `POST /api/workspace/notifications/telegram/test` sends only a fixed safe
  test line to the current active/enabled chat.
- `POST /api/workspace/notifications/telegram/unbind` revokes the binding,
  increments its authorization version, and cancels pending/not-started rows.
- `GET /api/workspace/notifications/telegram/deliveries?limit=...` returns
  owner-scoped status metadata without body or attachment content.
- `POST /api/workspace/notifications/telegram/deliveries/:id/retry` is a
  manual owner-scoped retry for failed/retryable/unknown rows. The response
  carries a manual-duplicate warning for `unknown_delivery`.

`POST /api/webhooks/telegram` is not a browser API. It validates
`X-Telegram-Bot-Api-Secret-Token` before parsing or D1 access, accepts only
private non-bot chats, and deduplicates by Telegram `update_id`. See
[docs/TELEGRAM.md](./TELEGRAM.md) for setup, Cron and production evidence
limits.

## `/api/send` compatibility contract

`POST /api/send` is a compatibility adapter for the first-generation compose
client. It is still an authenticated workspace operation; it is not a public
Resend proxy. The adapter keeps `RESEND_API_KEY` server-side and applies the
same recipient/subject/body limits, sender authorization, and rate limits as
the workspace send route. `senderAddressId` is the requested managed identity;
the server resolves its From name/email/signature from D1. A new message may
omit the ID only when an explicit ready default sender exists. Arbitrary `from`
and client-controlled `replyTo` values do not set the outgoing identity.
Legacy `OUTBOUND_FROM_EMAIL` / `MAIL_FROM` values are used only for system
auto-replies and inbound notifications, never to override a workspace sender.

The minimum legacy request is:

```http
POST /api/send
Content-Type: application/json
Idempotency-Key: flaremail-legacy-client-20260823-001

{
  "senderAddressId": "managed-address-uuid",
  "to": "recipient@example.test",
  "subject": "Hello",
  "html": "<p>Hello from FlareMail</p>"
}
```

`to` may be a single address (the legacy shape); implementations may also
accept the current address-list form. `text`, `cc`, `bcc`, and RFC threading
fields are optional extensions. New clients should send `senderAddressId`; the
server still validates it against the authenticated Owner and current address
and domain send readiness. The server must reject an empty/invalid
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

On the first accepted logical send, the server persists the chosen address ID,
From name/email, signature-rendered body, recipient sets, threading data, and
Message-ID domain. Same-key retries replay that persisted payload and never
switch to a new default or signature. If that original address can no longer
send, retry stops with an explicit error and leaves its persisted delivery
state intact. `Reply-To` is omitted unless generated from trusted server state;
it is never copied from the client. Replies to inbound mail default to the
address that received that exact delivery, while replies to sent mail preserve
the sent item's historical sender identity.

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
text body, server-owned `senderAddressId` and From snapshot, an opaque
`bodyRevision`, visible attachment lifecycle summaries, and an integer
`attachmentRevision`. Draft writes include `senderAddressId` when changing the
selected identity and `expectedUpdatedAt`,
the version observed by the editor, and echo `bodyRevision` after a canonical
body write. A client must present that revision before changing a tiered body;
an edit based only on a list projection returns `DRAFT_BODY_RELOAD_REQUIRED`.

The server updates only when that version still matches. A stale write returns
HTTP `409` with a typed `DRAFT_CONFLICT` error containing only `draftId` and
`updatedAt`. The server validates the sender against the same Owner and stores
its current identity snapshot; client From/Reply-To headers do not override
that snapshot. The client keeps the local edit visible and explicitly fetches the
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
  "action": "archive|unarchive|read|unread|star|unstar|trash",
  "ids": ["selected-message-id"],
  "scope": {
    "section": "inbox|sent|archive",
    "identityFilter": null,
    "threadScope": "selected"
  }
}
```

`scope` is required; old clients that omit it receive `MAILBOX_SCOPE_REQUIRED`.
Every explicit ID is checked against the authenticated Owner and declared
section/address filter by the server before any write. `identityFilter` is
`null`, `{ "kind": "domain", "id": "..." }`, or
`{ "kind": "address", "id": "..." }`. A foreign identity, section, Owner,
or selected message outside that scope is rejected without a partial mutation.

The client selects only currently loaded rows. “Select all” means all rows
loaded in the current page that match the active search, unread, or starred
filter; it does not mean every result in `searchTotal`. A normal selected-message
operation (`threadScope: "selected"`) changes only the IDs in `ids` and must
not include `threadKeys`. A filtered-thread operation explicitly includes the
selected thread anchors and repeats the current `query` and `filter`; the server
checks each anchor belongs to an explicit ID and resolves only messages in
those threads that match that query, section, address
filter, and unread/starred filter. This can include matching messages outside
the loaded page, but never other search results. An Owner-wide thread operation
uses `threadScope: "owner"` and is an explicit expansion across the Owner's
addresses and inbox/archive/sent sections. Archive and unarchive still affect
only inbox rows; drafts are not bulk-thread targets.

All IDs are resolved and capped at 100 before the transaction. Oversized or
partially invalid requests fail before any write. The write is one D1
`batch()` transaction. Archive and unarchive only operate on inbox-owned rows
and change `archived_at`; they never rewrite `folder` to manufacture an archive
folder.

The response returns affected summaries, movement information, the resolved
scope, and metrics with an explicit `metricsScope.identityFilter`. A null
metrics identity is Owner-global; a domain/address value is scoped to that
identity and is not narrowed to the selected page or search. Clients discard
metrics from a different identity scope and refresh when a message delta does
not fit the current page.

Trash has no identity filter: entering it clears the current identity filter,
and its list/empty operation is Owner-global. A bulk `trash` action from an
inbox/sent/archive view is still scoped to the declared identity and section.

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
