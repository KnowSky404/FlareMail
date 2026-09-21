# ADR 0014: Stable Owner, managed mail identities, and Access authentication

- Status: Accepted
- Date: 2026-09-20
- Scope: personal FlareMail installations on Cloudflare Workers, D1, and R2

## Context

FlareMail is one person's mail workspace. Login identity, profile contact data,
and mail addresses have different lifecycles and must not grant one another
ownership or send permission. A single Worker continues to serve SvelteKit
HTTP/API requests, Email Routing `email()` events, and scheduled Telegram
outbox work plus bounded mail-domain health checks.

## Decisions

### Stable Owner and authentication principal

`workspace_owner` names the stable data owner and preserves the existing user ID
and `user_id`/`owner_user_id` relationships. Local username/password data lives
in the separate `workspace_auth_credentials` record; the username is normalized
independently from email. A profile email is optional contact information and
is never a mail identity.

`AUTH_MODE` is explicit: `local` or `cloudflare-access`. Local mode uses the
existing password hashing, D1 session hashing/expiry/revocation, secure cookies,
CSRF and rate limits. Access mode verifies the `Cf-Access-Jwt-Assertion` with
the trusted team issuer, configured application AUD, issuer JWKS endpoint,
allowed algorithm, expiry/time claims, and one configured subject. The verified
subject maps to the configured stable Owner. Access requests still use short
internal D1 sessions for revocable content capabilities such as CID images;
every private HTTP request must still pass Access verification. There is no
anonymous first-user bootstrap or fallback between auth modes.

The Access application policy must allow only the Owner's intended identity.
Protect every public Worker hostname, including `workers.dev`, with that
policy. The Worker independently rejects a missing/invalid assertion on every
private path, so another attached hostname cannot use a local application
cookie as a bypass. At the Cloudflare Access layer, exempt only the exact
Resend and Telegram webhook paths needed by those providers. Those handlers
still verify their own signatures/secrets, size and replay windows. The only
public application health route is minimal `/api/health`; detailed
`/api/readiness` requires a workspace session. Application logout revokes the
internal session and requests Cloudflare Access logout; logging out of an
upstream identity provider remains a separate account-level action.

### Managed domains and addresses

`mail_domains` explicitly maps one actual receiving domain to its Cloudflare
zone/account and Worker target, plus independent Cloudflare-routing and
Resend-sending check state. A subdomain must be configured as its own explicit
mapping. Zone visibility from an API token never enrolls a domain.

`mail_addresses` stores a stable address ID, Owner/domain, receive/send
switches, lifecycle and routing state, exact remote rule ID, display name,
signature, and optional default-sender flag. Creating addresses never creates
workspace users. The database enforces address uniqueness and at most one
enabled default sender per Owner.

The server-only Cloudflare client uses the configured zone and Worker names
with the Email Routing Rules API. Its token is a distinct Worker Secret with
`Email Routing Rules Read` and `Email Routing Rules Edit` (write) permissions
for the configured zone(s). It is never returned to a browser, written to D1,
or logged. Exact literal `to` rules route to the app's Worker. Managed-rule
ownership requires the saved rule ID, API source, exact FlareMail marker,
enabled literal recipient matcher, one Worker action, and the exact configured
Worker target. Deletion re-reads the zone immediately before deleting the
saved ID and reconciles the result before reporting completion. Cloudflare's
documented DELETE route is ID-based and exposes no conditional version
precondition; this narrows but cannot eliminate a change made between the
final read and DELETE. A matching existing Worker rule can be explicitly
imported; imported and conflicting rules are preserved by normal delete and
retry operations.

Create, check, enable, disable, delete, restore, and retry share the existing
per-address expiring operation lease. Writes compare the lease token and the
snapshot lifecycle/routing fields. A check that loses its lease reports the
address as busy and drops its stale result. Checks do not change send
permission or the default sender, and a successful route check does not turn
receiving back on for a disabled address. Migration 0026 records the explicit
address deletion policy. An authenticated read-only preview shows the exact
route observation, catch-all state/freshness, local lifecycle and retained
history before the user confirms. DELETE still performs its own immediate
provider reads; the preview is not an authorization token. `remove_owned_route`
removes only the verified FlareMail rule, while `retain_reject_route` keeps the
verified exact Worker rule so the deleted tombstone rejects that recipient
before catch-all collection. `preserve_imported_route` is limited to imported
rules and never mutates them; if the provider could not verify one, the result
does not claim that the remote rule was observed. A deleted address stays a
tombstone after either terminal outcome, and a deliberately retained rule is
reported as an expected observation rather than cleanup work. Restore requires
a terminal, reconciled deletion and a fresh route check. Cloudflare and D1 are
not transactional, so ambiguous outcomes remain retryable and every retry
reads the current rule before another destructive request. Operations do not
call the destination-address forwarding API or modify external catch-all rules.

Unknown recipients default to reject. `collect` is an explicit domain policy
that accepts an unregistered recipient only after a recent check proves that
the existing catch-all targets this Worker. Such mail retains its actual
recipient and is not a sendable address. Explicit disabled/deleted addresses
are rejected before catch-all handling. Deleting an address first disables
local receive/send and keeps a tombstone; remote cleanup failure remains
visible. A deleted identity is restored only through an explicit operation.
Address deletion does not remove its messages, attachments, body objects, or
R2 data. Removing this app's exact rule cannot block a separate external
catch-all that also receives the message.

### Inbound and outbound identity

The trusted `ForwardableEmailMessage.to` envelope recipient is resolved before
raw stream reads, MIME parsing, R2 writes, automatic replies, or notifications.
It is stored in `email_messages."to"` and linked to the matching address and
domain. MIME To/Cc/Reply-To and the parsed `Delivered-To` header remain separate
snapshots. Deduplication remains message identity plus envelope recipient, so
one RFC message delivered to two managed addresses produces two recipient
records. Telegram eligibility follows the resolved Owner/address, never a
login or profile email.

Inbox, sent mail, drafts, search, counts, page cursors, and bulk operations use
one owner-scoped `domain:<id>` or `address:<id>` filter on the server. The
unfiltered view remains the unified Owner mailbox. Bulk actions default to the
explicitly selected loaded messages; a filtered-thread expansion repeats the
active query and unread/starred filter and is bounded to that identity and
section. Expanding a thread across all Owner addresses and mailbox sections is
a separate explicit choice. Trash remains an Owner-global view and clears the
identity filter on entry. Historical records without a reliable managed
identity remain readable and searchable in that unified view; deletion does
not erase their history.

Every outbound draft/send stores the authorized sender address ID and immutable
From name/email and body/signature payload. New mail uses an explicitly ready
default or a selected ready address. Replies to inbound mail use the exact
envelope recipient for that delivery as From; replies to sent mail preserve
that message's original sender. Reply-All excludes every managed self address
and never copies inbound BCC. Client From/Reply-To values do not grant
authority. Resend verification is checked at the actual From domain, separately
from Cloudflare receiving readiness. `OUTBOUND_FROM_EMAIL` and its legacy
`MAIL_FROM` alias are reserved for system auto-replies and inbound
notifications. A same-key retry reuses the first send's full persisted payload
and address; it never silently falls back to another default sender.

## Data migration and recovery

Migrations `0023_owner_principal_auth.sql` and
`0024_managed_mail_identities.sql` append to the published sequence; migrations
0025 and 0026 add provider refresh state and explicit address deletion policy.
The current schema is version 26. They do not rebuild user/message/R2 ownership or
promote login/profile addresses into managed identities. Historical recipient
mapping remains explicit. Before an existing database is migrated, take a
verified D1 backup/Time Travel bookmark and run the local-only
`bun run mail:identity:dry-run -- --domain <configured-domain>` report on a
reviewed local copy. It includes users/Owner mapping, candidate envelope
recipients and senders, drafts, storage and Telegram ownership, unowned counts,
and conflicts. Multiple historical users require an explicit Owner selection;
unowned records are not assigned to the first visitor.

Historical address association is a separate, opt-in local workflow. The
`mail:identity:backfill` command writes a versioned plan scoped to one explicit
stable Owner and one configured address. It considers only inbound
`email_messages."to"` values whose existing `owner_user_id` already matches;
it never infers an address from MIME headers, `Delivered-To`, login/profile
data, or an old outbound `from_email`. Outbound sender IDs and drafts are left
for manual review/explicit sender choice. Plans are SHA-256-confirmed, expire
after 24 hours, bind to one local D1 persistence path, and contain at most 100
rows with a stable ID checkpoint. Apply revalidates the Owner/address/domain,
schema, plan expiry, and every row snapshot before issuing one conditional
metadata update; retries recognize rows already applied and report conflicts
or partial outcomes. The existing inbound search trigger refreshes its
address projection. IDs, ownership, message snapshots, mailbox flags, body and
attachment references, and R2 objects are not rewritten. The tool has no
remote mode; production changes remain a separately approved operation after
a verified backup and review of a local copy.

There is no generic down migration. If a migration needs reversal, stop writes
and use a reviewed D1 restore to a recorded pre-migration bookmark; then verify
R2 references and the matching Worker version. Ordinary code rollback keeps
the additive schema and all mail history.

For local-to-Access transition, back up D1, preserve the selected Owner ID,
bootstrap or confirm it with `bun run auth:bootstrap:access`, set
`ACCESS_OWNER_USER_ID` to that same ID, configure the Access application and
the trusted JWT settings, then change `AUTH_MODE`. Returning to local mode
requires an explicit deployment config change and local credential bootstrap;
the stable Owner and mail identities do not change. Mode changes do not copy an
Access email into the profile or create mail addresses.

### Mail health refresh and route observations

Migration 0025 adds independent Cloudflare and Resend next-check times, expiring
leases, errors, failure times, and retry counters to `mail_domains`. The
existing one-minute scheduled entry remains for Telegram, while an independently
caught task checks only due provider/domain rows, at most one per provider in
one invocation. Provider refresh uses read-only APIs and never creates or
deletes a Cloudflare rule. A separate `CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN` is
preferred; `CLOUDFLARE_EMAIL_ROUTING_TOKEN` remains the management credential
for address rule mutations and serves as a compatibility fallback for checks.

A healthy provider check schedules another check 16–20 hours later. A valid
observation of a non-ready domain or route schedules a six-hour review;
retryable API failures back off up to 20 hours and permission/configuration
failures retry after six hours. Failed or unknown provider responses do not change the last
successful check timestamp. The shared 24-hour freshness rule gates sending
and `collect`; a previously verified explicit `collect` domain may use one
additional 24-hour window only after a transient Cloudflare network, timeout,
rate-limit, or upstream error. This bounded path does not advance the verified
timestamp, and it never applies to unknown domains, observed target mismatches,
missing credentials, disabled domains, or tombstoned addresses.

The Email Routing handler reference documents explicit rejection but does not
promise handler-throw redelivery. FlareMail therefore does not present throws
as a retry guarantee. Existing managed recipients resolve independently of
optional provider-health failures. Route checks update observed routing state
without changing an Owner's `receive_enabled` preference; transient read
failures leave both values untouched. Manual and scheduled checks share the
provider lease, timeout, and success/error timestamp contract.

Private `/api/readiness` returns per-domain provider state, last successful
observation, next due time, last error time and safe error code. Public
`/api/health` remains a minimal liveness response. Current Resend API keys offer
Full access or Sending access; domain status reads use the deployment's
`RESEND_API_KEY`, whose domain-read operation requires the full-access class.

## Consequences

- One personal workspace can manage multiple receiving and sending addresses
  without per-address users, passwords, sessions, or permissions.
- Mail can continue receiving before any local password is installed, while
  address ownership still resolves to the configured Owner.
- Cloudflare route health and Resend sending health are independent; a domain
  may receive mail while its addresses are not send-ready.
- Remote route operations can require an operator check/retry after ambiguous
  provider outcomes. The app reports this state instead of claiming success.
- This decision does not introduce teams, invitations, RBAC, multi-tenancy,
  SMTP/IMAP, DNS hosting, or automatic zone discovery.
