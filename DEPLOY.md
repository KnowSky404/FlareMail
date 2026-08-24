# FlareMail authoritative production deployment guide

This is the authoritative guide for a first production deployment and for
ordinary production upgrades. It follows the current code, checked-in scripts,
Wrangler configuration, D1 migrations, Cloudflare Email Routing integration,
and Resend integration. Use [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) for
maintenance and recovery procedures, and
[docs/PRODUCTION_CHECKLIST.md](./docs/PRODUCTION_CHECKLIST.md) as the release
gate.

This document contains operator commands, but this repository task does not
run production deployment, remote D1 migrations, Email Routing changes,
Resend sends or webhook registration. Keep production data, credentials and
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
bun --version                         # must print 1.3.14
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
Then, after a separate migration approval:

```bash
bun run db:migrate:remote
```

Bootstrap the administrator only after migrations succeed. The password is
read from the current shell and is never written to a config file:

```bash
export FLAREMAIL_ADMIN_EMAIL='mail@example.com'
export FLAREMAIL_ADMIN_NAME='FlareMail Administrator'
export FLAREMAIL_ADMIN_PASSWORD='use-a-long-unique-password'
bun run auth:bootstrap:remote
unset FLAREMAIL_ADMIN_EMAIL FLAREMAIL_ADMIN_NAME FLAREMAIL_ADMIN_PASSWORD
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

This bootstrap deploy is allowed to create the Worker before Resend secrets
exist because the current private config does not declare Wrangler
`secrets.required`. The application intentionally fails closed while required
production values are absent, so a temporary `/api/health` 503 is expected at
this checkpoint. Do not send traffic to it and do not enable Email Routing.

After the Worker exists, attach the reviewed Custom Domain and create the
Resend webhook for that public URL. Prepare a mode-0600 secrets file through
the operator's secret manager outside the repository. It must contain exactly
the two values needed by this Worker, for example:

```json
{
  "RESEND_API_KEY": "<value supplied by the secret manager>",
  "RESEND_WEBHOOK_SECRET": "<value copied from Resend>"
}
```

Do not commit this file, put it under the project directory, or paste its
contents into a shell transcript. Then upload code and both secrets as one
Worker version:

```bash
bun run build
bun x wrangler deploy --strict \
  --config wrangler.deploy.toml \
  --secrets-file /secure/path/flaremail-secrets.json
bun x wrangler secret list --config wrangler.deploy.toml --format pretty
```

PAUSE: `secret list` may show names only; never print or record values. The
`--secrets-file` upload is the first-deployment final release step: it makes
the code, config, bindings and both Resend secrets available in one Worker
version. Remove the temporary file through the secret manager after the
operator has confirmed its retention policy.

```bash
curl --fail --silent --show-error https://mail.example.com/api/health
```

Expected health status is HTTP 200. Only after that response and the binding,
secret, domain and webhook review pass may the operator enable Email Routing
and run the inbound/outbound smoke tests described below.

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

`package.json` declares `packageManager: "bun@1.3.14"` and an engine minimum of
`>=1.3.14`. `scripts/release-preflight.ts` additionally requires the running
Bun version to equal the exact `packageManager` version. Use Bun 1.3.14 for a
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
APP_ORIGIN = "https://mail.example.com"
OUTBOUND_PROVIDER = "resend"
OUTBOUND_FROM_EMAIL = "flaremail@send.example.com"
OUTBOUND_FROM_NAME = "FlareMail"
RESEND_API_BASE_URL = "https://api.resend.com"
AUTO_REPLY_ENABLED = "true"
INBOUND_NOTIFICATION_ENABLED = "true"
NOTIFICATION_EMAIL = "ops@example.com"
```

`APP_ORIGIN` must be the credential-free HTTPS origin with no path, query or
fragment. Set notification and auto-reply switches deliberately; they are
real outbound behavior. The `DB` binding must use the production D1 ID and the
`BUCKET` binding must use the production R2 name. Keep `ASSETS`, logs, traces,
and the checked-in compatibility date/flag aligned with the example.

Never put `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`,
`CLOUDFLARE_API_TOKEN`, an administrator password or any other secret in TOML.
Use Wrangler secrets for the two Resend values. `.dev.vars` is for local
development only and is not a production input.

### 6. Deployment invariants

Check these relationships before creating routes or sending mail.

#### Email Routing recipient ↔ FlareMail administrator

The current owner lookup in `src/lib/server/db/inbound.ts` is equivalent to:

```sql
WHERE lower(login_email) = lower(?) OR lower(email) = lower(?)
```

The administrator bootstrap writes the normalized address to both columns.
Under the current single-administrator model, the Cloudflare Email Routing
recipient must therefore match `FLAREMAIL_ADMIN_EMAIL` (and the resulting
FlareMail `login_email`/`email`). A mismatch stores the message as an
unassigned inbound record instead of showing it in that administrator's Inbox.

Recommended first deployment mapping:

```text
Cloudflare Email Routing recipient: mail@example.com
FLAREMAIL_ADMIN_EMAIL:              mail@example.com
```

The lookup is case-insensitive, but do not rely on aliases or plus-addressing
unless the current code and a controlled smoke test explicitly support them.

#### APP_ORIGIN ↔ Worker Custom Domain

If the Worker Custom Domain is `mail.example.com`, configure:

```text
APP_ORIGIN=https://mail.example.com
```

This origin participates in secure session-cookie selection, CSRF/Origin
validation and the public webhook/API URL. A `.workers.dev` hostname may be
used for an isolated bootstrap check, but production `APP_ORIGIN` must match
the actual HTTPS Custom Domain exactly.

#### OUTBOUND_FROM_EMAIL ↔ Resend verified domain

If the configured sender is:

```text
OUTBOUND_FROM_EMAIL=flaremail@send.example.com
```

then `send.example.com` must be verified in Resend before production sending.
The application accepts `submitted` after the Resend API accepts a message;
only a verified signed `email.delivered` webhook can establish `delivered`.

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
- Wait for Resend to show the domain as `verified` before setting
  `OUTBOUND_FROM_EMAIL` to an address on that domain or running an outbound
  smoke test.

References: [Resend domain verification](https://resend.com/docs/dashboard/domains/introduction)
and [Resend DMARC guidance](https://resend.com/docs/dashboard/domains/dmarc).

### 8. D1 migrations and pre-migration evidence

At the current `main` release, `migrations/0001_baseline.sql` through
`migrations/0018_outbound_rate_limits.sql` are present and
`src/lib/server/db/schema-version.ts` declares schema version `18`. Treat this
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
command, verify `workspace_schema_metadata.schema_version` and the health
required tables through the health check and the release evidence.

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

### 9. Administrator bootstrap

The bootstrap script requires an email, name and password in the current shell;
it rejects passwords shorter than 12 characters and performs an upsert by
`login_email`, updating credentials rather than creating duplicate admins.
Use a unique password stored in a password manager. Shell history and process
environment exposure are operator risks; unset the variables immediately.

POSIX shell:

```bash
export FLAREMAIL_ADMIN_EMAIL='mail@example.com'
export FLAREMAIL_ADMIN_NAME='FlareMail Administrator'
export FLAREMAIL_ADMIN_PASSWORD='use-a-long-unique-password'
bun run auth:bootstrap:remote
unset FLAREMAIL_ADMIN_EMAIL FLAREMAIL_ADMIN_NAME FLAREMAIL_ADMIN_PASSWORD
```

PowerShell:

```powershell
$env:FLAREMAIL_ADMIN_EMAIL = 'mail@example.com'
$env:FLAREMAIL_ADMIN_NAME = 'FlareMail Administrator'
$env:FLAREMAIL_ADMIN_PASSWORD = '<read a long unique password securely>'
bun run auth:bootstrap:remote
Remove-Item Env:FLAREMAIL_ADMIN_EMAIL, Env:FLAREMAIL_ADMIN_NAME, Env:FLAREMAIL_ADMIN_PASSWORD
```

The administrator email must be the same address selected in the Email Routing
recipient invariant above. Do not put it in a secret file or commit it with a
password.

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

Verify that the public URL exactly matches `APP_ORIGIN`. `.workers.dev` can
remain available as a diagnostic endpoint, but it is not a substitute for the
configured production origin.

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

Only after the final `/api/health` response is HTTP 200 and the operator has
reviewed D1, R2, Resend, Custom Domain and webhook configuration:

1. Open the zone's **Email Routing** dashboard and choose **Enable/Get
   started**. Follow the current DNS instructions and confirm the MX/TXT
   records are active.
2. Open **Destination Addresses**, add an operator-controlled destination
   mailbox, and complete the verification email. The destination address is a
   Cloudflare Email Routing setup prerequisite and verification target; it is
   not the incoming FlareMail recipient.
3. Open **Routing Rules** (the dashboard may label this **Routes**) and choose
   **Create address** for the intended incoming recipient, for example
   `mail@example.com`. This address must still equal the bootstrapped
   administrator email under the current owner lookup.
4. Choose **Send to a Worker**, then select the deployed `flaremail` Worker.
   Do not choose **Forward to email**; forwarding bypasses the Worker
   `email()` handler.
5. Confirm the rule is active, matches the intended recipient, and is not
   shadowed by a higher-priority catch-all or forwarding rule.
6. Send the controlled inbound smoke message only after the route is active.

See [Cloudflare Email Routing destination addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)
and [Cloudflare route emails to a Worker](https://developers.cloudflare.com/email-service/get-started/route-emails/).

### 13. Health check and production smoke

Run the runtime readiness check:

```bash
curl --fail --silent --show-error https://mail.example.com/api/health
```

HTTP 200 proves that runtime configuration, D1 bindings and the required
schema tables are ready. It does not prove login, Email Routing, R2 object
integrity, Resend API acceptance, webhook delivery or mailbox delivery.

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
2. Confirm Bun 1.3.14, run the release gates and review the private config.
3. Record the D1 target and a current Time Travel bookmark/timestamp before
   any migration.
4. Review and apply new migrations in order with `bun run db:migrate:remote`.
5. Deploy the exact release with `bun run deploy` and verify `/api/health`.
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
- Email Routing recipient, rule priority and Worker target; and
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
