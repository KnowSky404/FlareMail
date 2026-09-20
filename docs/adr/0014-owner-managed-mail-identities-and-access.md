# ADR 0014: Stable Owner, managed mail identities, and Access authentication

- Status: Accepted
- Date: 2026-09-20
- Scope: personal FlareMail installations on Cloudflare Workers, D1, and R2

## Context

FlareMail is one person's mail workspace. Login identity, profile contact data,
and mail addresses have different lifecycles and must not grant one another
ownership or send permission. A single Worker continues to serve SvelteKit
HTTP/API requests, Email Routing `email()` events, and scheduled Telegram
outbox work.

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
or logged. Exact
literal `to` rules route to the app's Worker. A matching existing Worker rule
can be explicitly imported; conflicting rules are reported and left alone.
Cloudflare and D1 are not transactional, so operations persist provisioning,
active, deleting, deleted, or error state and support reconciliation/retry.
They do not call the destination-address forwarding API or modify external
catch-all rules.

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
unfiltered view remains the unified Owner mailbox. Historical records without
a reliable managed identity remain readable and searchable in that unified
view; deletion does not erase their history.

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
`0024_managed_mail_identities.sql` append to the published sequence and advance
the current schema to 24. They do not rebuild user/message/R2 ownership or
promote login/profile addresses into managed identities. Historical recipient
mapping remains explicit. Before an existing database is migrated, take a
verified D1 backup/Time Travel bookmark and run the local-only
`bun run mail:identity:dry-run -- --domain <configured-domain>` report on a
reviewed local copy. It includes users/Owner mapping, candidate envelope
recipients and senders, drafts, storage and Telegram ownership, unowned counts,
and conflicts. Multiple historical users require an explicit Owner selection;
unowned records are not assigned to the first visitor.

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
