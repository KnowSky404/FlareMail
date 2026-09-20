# FlareMail authoritative production deployment guide

This is the authoritative guide for a first production deployment and for
ordinary production upgrades. It follows the current code, checked-in scripts,
Wrangler configuration, D1 migrations, Cloudflare Email Routing integration,
and Resend integration. Use [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) for
maintenance and recovery procedures, and
[docs/PRODUCTION_CHECKLIST.md](./docs/PRODUCTION_CHECKLIST.md) as the release
gate.

This document contains operator commands, but this repository task does not
run production deployment, remote D1 migrations, Email Routing or Access
changes, Resend sends or webhook registration. Keep production data, credentials and
secrets out of terminals shared with other people and out of release evidence.

## Production Quick Start

Read the complete guide before executing this sequence. Every `PAUSE` is an
operator review checkpoint; do not paste the whole section into a shell. The
commands deliberately do not create Email Routing rules, create a Resend
webhook, restore D1, delete R2 objects, or contain a password/token.

### Lock the release and prepare the local checkout

```bash
git fetch origin main
git switch main
git pull --ff-only origin main
test -z "$(git status --porcelain=v1)"
RELEASE_SHA="$(git rev-parse HEAD)"
git merge-base --is-ancestor "$RELEASE_SHA" origin/main
bun --version                         # must print 1.4.0
bun install --frozen-lockfile
```

PAUSE: record `RELEASE_SHA`, confirm the matching GitHub Actions checks are
green, and stop if the worktree is dirty or the SHA is not reachable from
`origin/main`. A release may use a separately approved immutable commit, but
that SHA must still be recorded and verified as an ancestor of `origin/main`.

### Authenticate and create resources

```bash
bun x wrangler login --use-keyring
bun x wrangler whoami
```

```bash
bun x wrangler d1 create flaremail-db
bun x wrangler r2 bucket create <UNIQUE_PRODUCTION_R2_BUCKET_NAME>
```

PAUSE: record the D1 `database_id` and the exact R2 bucket name. Edit a private
`wrangler.deploy.toml` from the checked-in example; never put a Cloudflare
token, database ID, production bucket name, Resend key, webhook secret or
administrator password into Git.

### Prepare D1, administrator and the release

```bash
cp wrangler.deploy.toml.example wrangler.deploy.toml
# Edit wrangler.deploy.toml with the reviewed production values.

bun x wrangler d1 info flaremail-db --config wrangler.deploy.toml
bun x wrangler d1 time-travel info flaremail-db --config wrangler.deploy.toml
bun x wrangler d1 migrations list flaremail-db --remote --config wrangler.deploy.toml
```

PAUSE: verify that `d1 info` identifies the intended production database and
that the Time Travel bookmark/timestamp is recorded before the first migration.
For an existing database, first review a local copy with the read-only audit
(it rejects `--remote`):

```bash
bun run mail:identity:dry-run -- --domain example.com --json
```

The report includes historical users and Owner mappings, envelope recipients,
outbound and draft addresses, attachment/body and Telegram ownership, unowned
records and conflicts. It does not change D1 or promote login/profile emails to
managed addresses. Migrations `0023` and `0024` are additive; there is no
generic down migration. Multiple historical users require an explicit
`FLAREMAIL_OWNER_USER_ID` during bootstrap; do not merge their data implicitly.

Then, after a separate migration approval:

```bash
bun run db:migrate:remote
```

Bootstrap the administrator only after migrations succeed. The password is
read from the current shell and is never written to a config file:

```bash
export FLAREMAIL_ADMIN_USERNAME='flower'
export FLAREMAIL_ADMIN_NAME='FlareMail Administrator'
export FLAREMAIL_ADMIN_PASSWORD='use-a-long-unique-password'
bun run auth:bootstrap:remote
unset FLAREMAIL_ADMIN_USERNAME FLAREMAIL_ADMIN_NAME FLAREMAIL_ADMIN_PASSWORD
```

Run the local release gates from the clean, locked checkout:

```bash
bun run audit:dependencies
bun run check
bun test src scripts
bun run build
bun run release:preflight -- --json
bun run deploy:dry-run
```

### Bootstrap, configure secrets, and deploy the final release

Keep Email Routing disabled. Create the Worker first:

```bash
bun run deploy
```

This bootstrap deploy creates the Worker before mail secrets exist. Public
`/api/health` is only a minimal liveness check and may return `200` while
configuration or D1 is unavailable. Private routes fail closed. Do not treat
liveness as readiness, enable Email Routing, or run a mail smoke test at this
checkpoint.

After the Worker exists, attach the reviewed Custom Domain and create the
Resend webhook for that public URL. Prepare a mode-0600 secrets file through
the operator's secret manager outside the repository. It contains the two
required Resend secrets and, when using the in-app address manager, the
separate zone-scoped Email Routing Rules token:

```json
{
  "RESEND_API_KEY": "<value supplied by the secret manager>",
  "RESEND_WEBHOOK_SECRET": "<value copied from Resend>",
  "CLOUDFLARE_EMAIL_ROUTING_TOKEN": "<zone-scoped Email Routing Rules token>"
}
```

Do not commit this file, put it under the project directory, or paste its
contents into a shell transcript. Then upload code and selected secrets as
one Worker version:

```bash
bun run build
bun x wrangler deploy --strict \
  --config wrangler.deploy.toml \
  --secrets-file /secure/path/flaremail-secrets.json
bun x wrangler secret list --config wrangler.deploy.toml --format pretty
```

PAUSE: `secret list` may show names only; never print or record values. The
`--secrets-file` upload is the first-deployment final release step: it makes
the code, config, bindings and selected Worker secrets available in one Worker
version. Remove the temporary file through the secret manager after the
operator has confirmed its retention policy.

```bash
curl --fail --silent --show-error https://mail.example.com/api/health
```

HTTP 200 proves only that the Worker HTTP entry point responds. Sign in through
the configured auth mode and request `/api/readiness` before continuing. Only
after readiness and the binding, secret, domain and webhook review pass may
the operator enable Email Routing and run the inbound/outbound smoke tests.

## First Production Deployment

### 1. Release identity and evidence

Production must be deployed from a clean checkout. The supported default is
`main`; a release commit selected by an approved release process is also
acceptable when its full SHA is recorded. Do not use a dirty worktree or rely
on a feature branch relationship from an old release.

POSIX shell:

```bash
git fetch origin main
git switch main
git pull --ff-only origin main
git status --short
git rev-parse HEAD
git merge-base --is-ancestor "$(git rev-parse HEAD)" origin/main
```

PowerShell:

```powershell
git fetch origin main
git switch main
git pull --ff-only origin main
git status --short
$releaseSha = git rev-parse HEAD
git merge-base --is-ancestor $releaseSha origin/main
```

The status command must print nothing. Record the 40-character SHA and check
the CI results for that exact SHA in GitHub Actions before any remote change.
If using GitHub CLI, `gh run list --commit <RELEASE_SHA>` is a convenient view;
the release gate is the actual completed status of every required job, not the
existence of a run.

### 2. Bun and Wrangler versions

`package.json` declares `packageManager: "bun@1.4.0"` and an engine minimum of
`>=1.4.0`. `scripts/release-preflight.ts` additionally requires the running
Bun version to equal the exact `packageManager` version. Use Bun 1.4.0 for a
production release; do not infer an acceptable version from the looser engine
range and do not upgrade Bun or Wrangler as part of deployment.

```bash
bun --version
bun install --frozen-lockfile
```

The current lockfile resolves the `^4.125.0` Wrangler development dependency
to `4.125.0`. The deploy and remote migration scripts run the repository's
configured Wrangler through Bun; do not silently substitute a global version.

### 3. Cloudflare authentication

For an interactive workstation:

```bash
bun x wrangler login --use-keyring
bun x wrangler whoami
```

For a remote SSH/VPS terminal where a browser callback is not available:

```bash
bun x wrangler login --use-keyring --device
bun x wrangler whoami
```

For CI or another non-interactive runner, provide `CLOUDFLARE_API_TOKEN` from
the runner's secret store. Do not put it in Git, `wrangler.deploy.toml`, shell
transcripts, pull-request bodies or logs, and do not echo it:

```bash
export CLOUDFLARE_API_TOKEN='<injected by the secret store>'
bun x wrangler whoami
```

PowerShell uses the same Wrangler commands. Set the token through the CI
secret mechanism rather than saving it in a profile or project file.

### 4. Cloudflare production resources

Create resources only after authentication and record the returned identifiers
in the private deployment evidence:

```bash
bun x wrangler d1 create flaremail-db
bun x wrangler r2 bucket create <UNIQUE_PRODUCTION_R2_BUCKET_NAME>
```

The D1 database name is fixed by `package.json` scripts and
`wrangler.deploy.toml.example`: `flaremail-db`. Replace its placeholder
`database_id` with the UUID returned by Cloudflare. Replace the R2 bucket
placeholder with the bucket created for production.

The checked-in development `wrangler.toml` has
`preview_bucket_name = "flaremail-bucket-preview"` so local/preview Wrangler
bindings can use an isolated bucket. Wrangler selects that field only when a
preview binding is requested; a production `wrangler deploy` uses
`bucket_name`. The production deployment example therefore does not require a
preview bucket. Create one only for a separately reviewed Preview/local
workflow, and never point it at production data.

### 5. Private production Wrangler configuration

Create the private file once:

```bash
cp wrangler.deploy.toml.example wrangler.deploy.toml
```

PowerShell:

```powershell
Copy-Item wrangler.deploy.toml.example wrangler.deploy.toml
```

`wrangler.deploy.toml.example` is safe to commit. `wrangler.deploy.toml` is
the only production deployment config and is ignored by Git. `wrangler.toml`
is the development/local template and must not be used to deploy production.

The private file must retain the checked-in Worker name, entry point, assets
binding and observability settings, and must set reviewed values for at least:

```toml
APP_ENV = "production"
OUTBOUND_PROVIDER = "resend"
OUTBOUND_FROM_EMAIL = "flaremail@send.example.com"
OUTBOUND_FROM_NAME = "FlareMail"
RESEND_API_BASE_URL = "https://api.resend.com"
AUTO_REPLY_ENABLED = "true"
INBOUND_NOTIFICATION_ENABLED = "true"
NOTIFICATION_EMAIL = "ops@example.com"
```

Browser mutation origin validation is derived from each incoming request URL,
so production does not require a hostname allowlist variable. Set notification
and auto-reply switches deliberately; they are real outbound behavior. The
`DB` binding must use the production D1 ID and the `BUCKET` binding must use
the production R2 name. Keep `ASSETS`, logs, traces, and the checked-in
compatibility date/flag aligned with the example.

Never put `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`,
`CLOUDFLARE_API_TOKEN`, an administrator password or any other secret in TOML.
Use Wrangler secrets for the two Resend values. `.dev.vars` is for local
development only and is not a production input.

### Authentication mode and stable Owner

Set `AUTH_MODE` explicitly. `local` uses a custom username and password;
`cloudflare-access` accepts only a validated Access JWT for the configured
Owner. Do not configure local credentials as a fallback to Access. Both modes
use the same `workspace_owner.user_id`; changing mode does not move mail or
create another Owner.

For local mode, set a username such as `flower` and a password in the current
shell; no email is required. An optional `FLAREMAIL_PROFILE_EMAIL` is contact
data only. `bun run auth:bootstrap:remote` updates local credentials and
revokes earlier local sessions. Keep each value out of config, command
arguments, logs, and shared terminal transcripts.

For Access-only mode:

1. Back up D1 and preserve the current Owner ID. On a new Access-only
   installation, `bun run auth:bootstrap:access:remote` creates the stable
   Owner without a local username or password. If historical users exist,
   first review them and provide `FLAREMAIL_OWNER_USER_ID`; the bootstrap
   refuses to choose among multiple users implicitly.
2. In the private Worker config set `AUTH_MODE = "cloudflare-access"`,
   `ACCESS_OWNER_USER_ID` to that same Owner ID, `ACCESS_ISSUER` to the exact
   `https://<team>.cloudflareaccess.com` origin, `ACCESS_AUDIENCE` to the
   Access application's AUD, `ACCESS_JWKS_URL` to that issuer's exact
   `/cdn-cgi/access/certs` endpoint, and `ACCESS_ALLOWED_SUBJECT` to the one
   intended Owner `sub`. The Worker verifies JWT signature, allowed algorithm,
   issuer, audience and time claims; it does not trust email headers or decode
   an unverified token.
3. Configure the Cloudflare Access HTTP application for every hostname that
   reaches the Worker, including `workers.dev`, and use an Allow/Include policy
   for only the Owner's intended identity. Do not use an entire email domain as
   the only authorization rule. Keep the app's AUD, issuer, and configured
   subject aligned; invalid or unavailable verification fails closed.
4. In the outer Access policy, exempt only the exact paths
   `/api/webhooks/resend` and `/api/webhooks/telegram` on the provider-facing
   hostname, using the platform's exact hostname/path rule. Do not exempt
   `/api`, `/api/*`, or mailbox paths. Each webhook still enforces Svix or
   Telegram secret validation. `/api/health` is deliberately public and
   returns only liveness; `/api/readiness` remains private.
5. Confirm a normal private page and `/api/readiness` work through Access and
   that an alternate Worker hostname without an Access assertion returns
   `401`. The application independently verifies Access on every private
   request, including SSR/data, reader, HTML/CID, raw, and attachment paths.

Application logout revokes its D1 session and redirects through
`/cdn-cgi/access/logout`. This ends the Access application session; whether an
upstream IdP session also ends depends on that IdP. If Access immediately
authenticates the browser again, use the IdP's own logout when signing out of
that provider is required.

To return to local login, back up D1, change `AUTH_MODE` to `local`, run
`bun run auth:bootstrap:remote` with a new username/password, and deploy the
reviewed config. The Owner ID, mail addresses, and historical data stay fixed;
no Access email is copied into a mailbox address. These are operator-side
remote actions and are not part of a local verification run.

### Managed mail domain and address setup

Configure only domains you explicitly intend to receive. Record the actual
mail domain, its exact Cloudflare zone ID, account ID when needed, Worker name,
and unknown-recipient policy. A subdomain is an independent mapping; do not
infer its zone from the parent or enroll every zone visible to the API token.

The secret `CLOUDFLARE_EMAIL_ROUTING_TOKEN` is separate from the Wrangler
deployment token. On the selected zone(s), grant `Email Routing Rules Read`
for list/catch-all checks and `Email Routing Rules Edit` for create/delete
(the API endpoint reference labels that write permission `Email Routing Rules
Write`). The client does not manage or verify destination addresses, so it
does not need the account-level Email Routing Addresses permissions. Do not
grant account-wide editing or reuse a deploy token. The token is never stored
in D1 or returned to the UI. See the current [Cloudflare token permission
groups](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
and [Email Routing rule endpoint permissions](https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/).

Use `bun run mail:domain:configure -- --remote` with
`FLAREMAIL_MAIL_DOMAIN_NAME`, `FLAREMAIL_CLOUDFLARE_ZONE_ID`,
`FLAREMAIL_EMAIL_WORKER_NAME`, and optional
`FLAREMAIL_CLOUDFLARE_ACCOUNT_ID` / `FLAREMAIL_UNKNOWN_RECIPIENT_POLICY` in
the current shell. This records one explicit domain mapping in D1. Then use
Profile → Mail identities to add addresses and check routing and Resend state.
The Worker creates exact literal `to` rules for its own email handler; it does
not create Email Routing destination addresses or forwarding rules. A matching
existing rule for this Worker may be imported after review. A rule that targets
another Worker or email destination is a conflict and remains untouched.

Cloudflare Email Routing receiving readiness and Resend sending readiness are
separate. Resend must show the domain of the actual `From` address as verified
and sending-enabled; a `send.example.com` return-path/DKIM setup does not
authorize a different `@example.com` From address. Each same-domain address
reuses the domain check. An address may receive mail while sending remains
disabled or unverified.

The default unknown-address policy is reject. `collect` may be selected only
when a recent check proves the existing catch-all targets this Worker. A
collected unknown address cannot send. Disabled/deleted explicit addresses are
rejected before catch-all handling. Do not edit, enable, or remove an external
catch-all. Deleting this application's precise rule does not stop delivery
through a separate external catch-all; the UI reports that boundary. To
restore an address, use its explicit restore action; the deleted row is never
silently revived by synchronization.

### Telegram notification channel (optional, additive)

Telegram is disabled in the checked-in templates. Read
[docs/TELEGRAM.md](./docs/TELEGRAM.md) completely before enabling it. The
feature requires migrations 0019-0022 and a single deployment-level Bot. For
the simpler online flow, enter the following non-secret values in the
Cloudflare Dashboard under **Settings → Variables and Secrets**:

```toml
TELEGRAM_ENABLED = "true"
TELEGRAM_BOT_USERNAME = "your_bot_username"
APP_BASE_URL = "https://mail.example.com"
TELEGRAM_TIMEOUT_MS = "5000"
```

`TELEGRAM_BOT_TOKEN` must be added as a Dashboard **Secret**, never a TOML
value. `TELEGRAM_WEBHOOK_SECRET` is optional and only needed as an independent
override. `wrangler.deploy.toml.example` includes
`keep_vars = true` so future code deployments preserve Dashboard-managed
variables. Apply the checkout's ordered migrations through schema version 24
(Telegram-specific migrations are 0019-0022) before the first enabled
deployment. After deployment, log in to FlareMail and click
**连接 / 更新 Webhook**; the page verifies `getMe` and registers only
`/api/webhooks/telegram` with `allowed_updates=["message"]`. No local `.env`,
manual `curl`, or administrator/ordinary-user role split is needed for this
personal-use flow.

After the Worker and webhook are verified, bind through the authenticated
settings page. `/start <token>` creates a disabled candidate, click
**确认绑定**, and separately enable notifications. The channel uses the
resolved managed envelope recipient and stable Owner, not the local username,
Access email, or editable profile email. `/stop`, UI unbind, token
rotation, and disabling the global var are additive and do not alter inbound
mail, Resend, or the legacy email notification channel.

Do not count local fake-fetch tests, a local scheduled request, health 200, or
an accepted Bot API response as real production delivery proof. Unknown
transport/finalization outcomes are recorded as `unknown_delivery`; manual
retry may duplicate a message and is explicitly warned in the UI. No
production webhook registration, Telegram send, or remote migration is part
of ordinary repository verification without separate authorization.

### 6. Deployment invariants

Check these relationships before creating routes or sending mail.

#### Email Routing envelope recipient ↔ managed address

The Worker resolves `ForwardableEmailMessage.to` against an explicitly
configured `mail_domains` row and an active, receive-enabled `mail_addresses`
row before reading the raw message or writing to R2. It stores that exact
envelope recipient in `email_messages."to"` and links the managed address ID.
MIME To/Cc and parsed `Delivered-To` are independent snapshots and do not grant
ownership. Local login username, Access identity/email, and profile email do
not affect mail ownership.

Configure the actual domain-to-zone/Worker mapping with
`bun run mail:domain:configure -- --remote`, then create or explicitly import
an exact Worker routing rule for each address from Profile → Mail identities.
The default unknown-recipient policy is reject. Optional collect requires a
recent check that the existing catch-all targets this Worker and never creates
a sendable address. A repeated delivery with the same RFC Message-ID to two
managed addresses remains distinct because recipient participates in
deduplication.

#### Browser origin ↔ incoming Worker domain

Every state-changing browser request must send an `Origin` that exactly
matches that request's own URL origin. The application derives this value from
the incoming Worker request, so all HTTPS Custom Domains attached to the Worker
and its enabled `.workers.dev` hostname work without a separately maintained
allowlist. Removing a domain or disabling `.workers.dev` makes that endpoint
unreachable without requiring an application configuration change.

Sessions use host-only cookies and are intentionally not shared across
different domains. A user must sign in separately on each hostname.

#### Selected From address ↔ Resend verified domain

Workspace sends use the explicitly selected or ready default managed address,
not `OUTBOUND_FROM_EMAIL`. If an address is:

```text
OUTBOUND_FROM_EMAIL=flaremail@send.example.com
```

then the exact domain `send.example.com` must be verified and sending-enabled in
Resend before that address can send. A sending/Return-Path subdomain does not
authorize a From address on another domain. `OUTBOUND_FROM_EMAIL` / `MAIL_FROM`
are reserved for system auto-replies and inbound notifications. The application
accepts `submitted` after the Resend API accepts a message; only a verified
signed `email.delivered` webhook can establish `delivered`.

#### Recommended domain topology

This separation is a recommendation, not a Cloudflare hard requirement:

```text
Web UI / Worker Custom Domain: mail.example.com
Inbound Email Routing:         mail@example.com
Resend sending domain:         send.example.com
Outbound From:                 flaremail@send.example.com
```

Keeping inbound routing on the business domain and outbound authentication on
a sending subdomain reduces SPF/MX operational coupling, isolates sending
reputation, and makes DNS ownership easier to review. Use the records generated
by the respective Cloudflare and Resend dashboards; never assume one provider's
record values or selectors.

### 7. Verify the Resend sending domain

In Resend Dashboard:

```text
Domains → Add Domain → enter the sending domain → publish the shown DNS records
```

Use the current dashboard output as the authority:

- Publish the Resend-generated SPF record. If the domain already has an SPF
  TXT record, merge the required mechanism into that one record; never publish
  a second `v=spf1` record.
- Publish the exact Resend-generated DKIM selector and target. Selectors,
  record types, targets and TTLs may change; do not hard-code them in this
  repository.
- Add DMARC at the sending domain after SPF/DKIM are understood. Starting with
  an observation policy such as `p=none` is an operator choice; tighten it
  after reviewing reports and alignment.
- Wait for Resend to show the exact domain of the intended managed `From`
  address as verified and sending-enabled before enabling that address for
  workspace sending. `OUTBOUND_FROM_EMAIL` is only a system auto-reply / inbound
  notification sender setting.

References: [Resend domain verification](https://resend.com/docs/dashboard/domains/introduction)
and [Resend DMARC guidance](https://resend.com/docs/dashboard/domains/dmarc).

### 8. D1 migrations and pre-migration evidence

At the current checkout, migrations `0001` through `0024` are present and
`src/lib/server/db/schema-version.ts` declares schema version `24`. Treat this
as a checked-in fact for this release, not a permanent promise: derive the
latest migration and schema version from the checkout before every release.

```bash
rg --files migrations | sort | tail -n 1
sed -n '1,20p' src/lib/server/db/schema-version.ts
```

For the intended production target, use current Wrangler commands:

```bash
bun x wrangler d1 info flaremail-db --config wrangler.deploy.toml
bun x wrangler d1 time-travel info flaremail-db --config wrangler.deploy.toml
bun x wrangler d1 migrations list flaremail-db --remote --config wrangler.deploy.toml
```

`d1 info` and `d1 time-travel info` operate on remote production D1; do not
add a legacy `--remote` flag to those Time Travel commands. Record the target,
the database state, the current Time Travel bookmark/timestamp, release SHA
and unapplied migration list before applying changes.

For a first empty database, apply every migration in numeric order:

```bash
bun run db:migrate:remote
```

Migrations are append-only release history. Never edit an already published
migration, skip a number, or downgrade D1 merely to run an older Worker. Apply
the migration before deploying Worker code that requires its schema. After the
command, verify `workspace_schema_metadata.schema_version` and required tables
through authenticated `/api/readiness`; public `/api/health` is liveness only.

D1 Time Travel is the normal short-window rollback evidence for supported
production databases. It is always on for the supported production backend;
retention depends on the current Cloudflare plan, so verify the plan at
release time. Do not create a routine snapshot backup as part of this SOP.
Time Travel restore is an incident operation, not a normal deployment step.

FTS5 is an important project-specific exception. Migration `0015` creates the
`workspace_search_fts` virtual layer and
`workspace_search_documents` is the canonical rebuildable projection. A
normal logical SQL export cannot include the virtual table. If a long-lived
logical export is explicitly required, use the reviewed procedure in
[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md): verify the index, prepare the
export, export while writes are frozen, restore the FTS layer, and verify again.
Never delete `workspace_search_documents` as a shortcut.

References: [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

### 9. Owner bootstrap

Local mode requires a custom username and password in the current shell; the
username need not be an email. Passwords must be at least 12 characters. An
optional profile email is not an authorization or mail identity. Resetting the
local credential updates the existing Owner and revokes its earlier local
sessions. Use a unique password stored in a password manager. Shell history and
process environment exposure are operator risks; unset values immediately.

POSIX shell:

```bash
export FLAREMAIL_ADMIN_USERNAME='flower'
export FLAREMAIL_ADMIN_NAME='FlareMail Administrator'
export FLAREMAIL_ADMIN_PASSWORD='use-a-long-unique-password'
bun run auth:bootstrap:remote
unset FLAREMAIL_ADMIN_USERNAME FLAREMAIL_ADMIN_NAME FLAREMAIL_ADMIN_PASSWORD
```

PowerShell:

```powershell
$env:FLAREMAIL_ADMIN_USERNAME = 'flower'
$env:FLAREMAIL_ADMIN_NAME = 'FlareMail Administrator'
$env:FLAREMAIL_ADMIN_PASSWORD = '<read a long unique password securely>'
bun run auth:bootstrap:remote
Remove-Item Env:FLAREMAIL_ADMIN_USERNAME, Env:FLAREMAIL_ADMIN_NAME, Env:FLAREMAIL_ADMIN_PASSWORD
```

For a new Access-only Owner, use `bun run auth:bootstrap:access:remote` without
local credentials. For an existing database with multiple historical users,
review the owner audit and set `FLAREMAIL_OWNER_USER_ID` to the explicitly
selected existing ID; bootstrap will not transfer or merge other users' mail.
The resulting Owner ID is the one configured as `ACCESS_OWNER_USER_ID`.

### 10. Pre-deployment verification

Run the minimum release gates from the exact release checkout:

```bash
bun install --frozen-lockfile
bun run audit:dependencies
bun run check
bun test src scripts
bun run build
bun run release:preflight -- --json
bun run deploy:dry-run
git diff --check
```

The preflight is read-only and checks the clean Git worktree, exact Bun
version, local-safe/public config boundaries, bindings, migration order,
schema version and snapshot, FTS/cleanup contracts, type generation and build
commands. `deploy:dry-run` builds a temporary config from public local
settings; it does not read or publish the private production config.

For a fuller browser release gate, run the isolated local suites:

```bash
bun run test:e2e
bun run test:e2e:webkit
bun run test:a11y
```

These tests use isolated local D1/R2 state and fake providers. They do not
prove Cloudflare production runtime capacity, real Email Routing, Resend
delivery, webhook registration, or real-device Safari behavior.

### 11. First deployment ordering and secrets

The following order keeps real inbound traffic off the Worker until every
runtime dependency is ready.

#### Phase A — bootstrap Worker, with Email Routing still disabled

```bash
bun run deploy
```

The script runs `bun run build`, then
`bun x wrangler deploy --strict --config wrangler.deploy.toml`. It uses the
private config only. The current code does not make Wrangler deploy fail just
because Resend secrets are absent; instead, non-health requests and health
checks report a configuration-unavailable state. Treat that state as expected
only during this short bootstrap phase.

#### Phase B — Custom Domain, webhook and secrets

Attach the Worker Custom Domain in Cloudflare Dashboard:

```text
Workers & Pages → flaremail → Settings → Domains & Routes
→ Add → Custom Domain → mail.example.com
```

Verify every intended public hostname over HTTPS. The same-origin policy will
accept browser mutations on each hostname that actually reaches this Worker;
`.workers.dev` may remain available as a separate endpoint or be disabled in
Cloudflare when only Custom Domains should be exposed.

Create the Resend webhook only after the Custom Domain resolves:

```text
Resend Dashboard → Webhooks → Add Webhook
Endpoint: https://mail.example.com/api/webhooks/resend
```

Subscribe to the event types handled by the current code:
`email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`,
`email.failed`, `email.complained`, and `email.suppressed`. The code also
records `email.opened` and `email.clicked` as timeline events without changing
the delivery status.

The endpoint verifies the raw request body and Svix signature headers; do not
parse and re-stringify webhook JSON before verification. Duplicate and
out-of-order events are protected by the existing persistence logic. Never
put either secret in TOML, `.dev.vars`, GitHub text or a log.

Prepare a mode-0600 secrets file through the operator's secret manager outside
the repository. It must contain exactly the two values needed by this Worker:

```json
{
  "RESEND_API_KEY": "<value supplied by the secret manager>",
  "RESEND_WEBHOOK_SECRET": "<value copied from Resend>"
}
```

Upload the exact release code and both secrets as one Worker version:

```bash
bun run build
bun x wrangler deploy --strict \
  --config wrangler.deploy.toml \
  --secrets-file /secure/path/flaremail-secrets.json
bun x wrangler secret list --config wrangler.deploy.toml --format pretty
```

Current Wrangler documents `secret put` as an immediate new Worker-version
deployment. Do not use it as the normal first-deployment path: sequential
commands create an intermediate version missing the other secret. If a secret
manager cannot materialize the file, the fallback is allowed only while Email
Routing is disabled, and the final `bun run deploy` is still required:

```bash
bun x wrangler secret put RESEND_API_KEY --config wrangler.deploy.toml
bun x wrangler secret put RESEND_WEBHOOK_SECRET --config wrangler.deploy.toml
bun run deploy
```

Never print or record secret values. Remove the temporary file through the
secret manager after its retention policy has been confirmed.

#### Phase C — final production deployment

```bash
bun x wrangler secret list --config wrangler.deploy.toml --format pretty
curl --fail --silent --show-error https://mail.example.com/api/health
```

Confirm the Worker version/release output and record only secret presence,
never secret values. With the canonical `--secrets-file` path, the deploy in
Phase B is the final reviewed release of the exact SHA. With the fallback
`secret put` path, the final `bun run deploy` in Phase B is that release.

### 12. Enable Cloudflare Email Routing last

Only after authenticated `/api/readiness` succeeds and the operator has
reviewed D1, R2, Resend, Custom Domain and webhook configuration:

1. Open the zone's **Email Routing** dashboard and choose **Enable/Get
   started**. Follow the current DNS instructions and confirm the MX/TXT
   records are active.
2. Open **Destination Addresses**, add an operator-controlled destination
   mailbox, and complete the verification email. The destination address is a
   Cloudflare Email Routing setup prerequisite and verification target; it is
   not the incoming FlareMail recipient.
3. Set `FLAREMAIL_MAIL_DOMAIN_NAME`, `FLAREMAIL_CLOUDFLARE_ZONE_ID`,
   `FLAREMAIL_EMAIL_WORKER_NAME=flaremail`, and the optional account/policy
   values in the operator shell. Run `bun run mail:domain:configure -- --remote`
   only after the reviewed remote D1 change is approved. The script writes one
   explicit domain mapping; it does not discover or enroll other zones.
4. Add `CLOUDFLARE_EMAIL_ROUTING_TOKEN` as a Worker Secret. It must be a
   separate token with `Email Routing Rules Read` and `Email Routing Rules
   Edit` (write) on the configured zone. Never reuse the Wrangler deployment
   token.
5. Log in to FlareMail and use Profile → Mail identities to add each address.
   The Worker creates an exact literal `to` rule targeting the configured
   Worker email handler. A pre-existing matching Worker rule may be imported
   after a read-only check. A rule to another Worker or a forward destination
   is reported as a conflict and is not taken over.
6. Review the exact address rule, domain-level catch-all status, and policy in
   the UI. Do not enable or modify an external catch-all. Deleting an exact
   FlareMail rule cannot intercept mail that an external catch-all still
   receives. Send the controlled inbound smoke message only after the exact
   address is active and receive-enabled.

See [Cloudflare Email Routing destination addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)
and [Cloudflare route emails to a Worker](https://developers.cloudflare.com/email-service/get-started/route-emails/).

### 13. Health check and production smoke

`/api/health` is public liveness only:

```bash
curl --fail --silent --show-error https://mail.example.com/api/health
```

HTTP 200 from `/api/health` proves only that the HTTP entry point responds.
Sign in through the configured auth mode and open `/api/readiness` to verify
runtime configuration, D1 bindings, required schema tables, and safe cleanup
counts. Readiness still does not prove Email Routing, R2 object integrity,
Resend API acceptance, webhook delivery, or mailbox delivery.

#### Inbound smoke

```text
External test mailbox
  → Cloudflare Email Routing
  → Worker email()
  → D1 owner-scoped message row
  → R2 raw/body/attachment objects
  → FlareMail Inbox
```

Use a unique test message and verify, without putting its body or full address
into shared evidence:

- the message appears in the administrator Inbox and owner mapping is correct;
- sender, recipient, subject, UTF-8/Chinese text and RFC threading are correct;
- raw `.eml`, plain text and sanitized HTML are readable;
- every attachment is downloadable from the same production R2 binding;
- size and SHA-256 integrity checks pass; and
- expected size/MIME rejects do not create a Worker failure.

#### Outbound smoke

```text
FlareMail Compose
  → Resend API
  → destination test mailbox
  → signed Resend webhook
  → D1 delivery timeline/status
```

Verify the local state first becomes `submitted` and record the provider
message ID. `email.sent` or a successful Resend API response means the provider
accepted the request; it is not proof that the destination mailbox received
the message. Only a valid signed `email.delivered` webhook supports the final
`delivered` state. Also check that no bounce, delay, failure, complaint or
suppression event contradicts the result.

### 14. Normal production upgrades

For every later release:

1. Lock a clean `main` checkout and record the immutable SHA and exact CI
   result.
2. Confirm Bun 1.4.0, run the release gates and review the private config.
3. Record the D1 target and a current Time Travel bookmark/timestamp before
   any migration.
4. Review and apply new migrations in order with `bun run db:migrate:remote`.
5. Deploy the exact release with `bun run deploy`, verify public liveness, then
   authenticate and verify private `/api/readiness`.
6. Preserve the existing Custom Domain, webhook and Email Routing rules unless
   a separately approved change is required. Run the smallest controlled smoke
   test that covers the changed behavior.

Do not run a Time Travel restore, logical export, R2 deletion or Email Routing
change as an implicit part of an ordinary code deployment.

### 15. Rollback and recovery

Before a release, record:

- current release SHA and previous known-good SHA;
- production Worker version and deployment time;
- D1 database target, schema version and pre-change Time Travel bookmark;
- the reviewed D1/R2 binding names and config checksum (without secrets);
- the Resend webhook endpoint, subscribed event set and secret-present status;
- configured managed domains/addresses, exact rule IDs, catch-all status and
  Worker targets; and
- the latest health, search, cleanup, attachment-integrity and delivery-review
  reports.

For a normal application rollback, deploy the previous known-good Worker
version from its exact clean checkout. A Worker rollback is not a D1 schema
rollback:

- keep append-only migrations, columns, queue rows and schema metadata;
- preserve raw `.eml`, body and attachment R2 objects; and
- do not drop new fields merely to make an older Worker start.

If data restoration is required, stop writes, enter an incident workflow and
obtain explicit approval. The current Wrangler command accepts either a
recorded bookmark or a timestamp and overwrites the target database:

```bash
bun x wrangler d1 time-travel restore flaremail-db \
  --bookmark='<RECORDED_BOOKMARK>' \
  --config wrangler.deploy.toml
```

Restore cancels in-flight queries and is destructive. It is never part of a
normal deployment or automated rollback. After an approved restore, verify
schema metadata, health-required tables, FTS projection/index, cleanup queue,
delivery reconciliation, attachment integrity and all referenced R2 objects.

For a logical SQL export, use only the FTS-aware maintenance procedure in
[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md). `workspace_search_documents` is
canonical; the FTS virtual layer is rebuilt after export/import or restore.

## Production documentation roles

- `README.md`: project overview, local quick start and links to production
  documentation.
- `DEPLOY.md`: this authoritative first-deployment and upgrade procedure.
- `docs/PRODUCTION_CHECKLIST.md`: checkable release gate for any future release.
- `docs/DEPLOYMENT.md`: maintenance CLI, search/FTS export, cleanup and
  incident-oriented recovery details.
- `docs/RC1_RELEASE.md`: historical RC-1 record only; it is not a current
  production release gate.

## Official references

- [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare Email Routing destination addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)
- [Cloudflare Email Routing to Workers](https://developers.cloudflare.com/email-service/get-started/route-emails/)
- [Resend domain verification](https://resend.com/docs/dashboard/domains/introduction)
- [Resend webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests)
