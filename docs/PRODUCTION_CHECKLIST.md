# FlareMail production release checklist

This is the checkable release gate for every future production release. The
complete first-deployment and upgrade procedure is
[DEPLOY.md](../DEPLOY.md); this file records evidence and stop conditions. It
does not authorize or perform deployment, remote migration, real mail,
webhook registration, Email Routing changes, D1 restore or R2 deletion.

Record the command, UTC timestamp, target and result for each checked item.
Never put secrets, passwords, cookies, message bodies, raw MIME, complete
recipient addresses or full R2 keys into shared evidence.

## Release identity

- [ ] The release is being prepared from `main`, or an explicitly approved
  immutable release commit has been selected and recorded.
- [ ] `git status --short` is empty.
- [ ] The 40-character `git rev-parse HEAD` SHA is recorded.
- [ ] The release SHA is reachable from `origin/main`:

  ```bash
  git fetch origin main
  git merge-base --is-ancestor <RELEASE_SHA> origin/main
  ```

- [ ] The exact SHA's required GitHub Actions jobs are completed and green.
- [ ] No gate depends on a historical RC branch, old base SHA, closed PR, or
  feature-branch relationship.
- [ ] The checkout uses Bun `1.3.14`, the exact `packageManager` version in
  `package.json`.
- [ ] `bun.lock` is committed and `bun install --frozen-lockfile` succeeds.
- [ ] `bun run audit:dependencies` reports no high-severity dependency issue.

## Target, configuration and invariants

- [ ] The target is explicitly recorded as production; no Preview command
  resolves to production D1, R2, Worker, Resend credentials or webhook.
- [ ] The private `wrangler.deploy.toml` was created from
  `wrangler.deploy.toml.example` and `git check-ignore wrangler.deploy.toml`
  confirms it is ignored.
- [ ] `wrangler.toml` is not being used for a production deploy.
- [ ] `APP_ENV=production` and `APP_ORIGIN` is the credential-free HTTPS origin
  of the actual Worker Custom Domain.
- [ ] `OUTBOUND_PROVIDER=resend` and `RESEND_API_BASE_URL` is the official
  `https://api.resend.com` origin or is omitted to use the code default.
- [ ] `DB`, `BUCKET` and `ASSETS` bindings point to the reviewed production
  resources. A preview R2 bucket is not required by the production config.
- [ ] `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` are present as Wrangler
  secrets; record only presence, never values.
- [ ] `OUTBOUND_FROM_EMAIL` belongs to a Resend domain whose status is
  `verified`.
- [ ] `AUTO_REPLY_ENABLED`, `INBOUND_NOTIFICATION_ENABLED` and
  `NOTIFICATION_EMAIL` were reviewed as real outbound behavior.
- [ ] The Email Routing recipient exactly matches the bootstrapped
  administrator's `login_email`/`email` under the current owner lookup.
- [ ] `APP_ORIGIN` exactly matches the Custom Domain used by the Web UI and
  webhook endpoint.

## D1 target and migration evidence

- [ ] The intended D1 target is confirmed with:

  ```bash
  bun x wrangler d1 info flaremail-db --config wrangler.deploy.toml
  ```

- [ ] The current Time Travel state/bookmark is recorded before migration:

  ```bash
  bun x wrangler d1 time-travel info flaremail-db --config wrangler.deploy.toml
  ```

  These Time Travel commands are remote-only in the current Wrangler CLI; do
  not add a legacy `--remote` option to them.
- [ ] The migration list was reviewed against the checked-out files:

  ```bash
  rg --files migrations | sort | tail -n 1
  bun x wrangler d1 migrations list flaremail-db --remote --config wrangler.deploy.toml
  ```

- [ ] The checkout's latest migration filename and schema version are recorded
  (currently migrations `0001` through `0018` and schema version `18`); the
  repository's `schema-version.ts` and preflight output were checked rather
  than relying on an old number.
- [ ] Every unapplied migration is approved and applied in numeric order:

  ```bash
  bun run db:migrate:remote
  ```

- [ ] No published migration was edited, skipped or downgraded.
- [ ] `workspace_schema_metadata.schema_version` and every health-required table
  are present after migration.
- [ ] `workspace_search_documents` remains canonical. Migration `0015`'s FTS5
  virtual layer is treated as rebuildable, not as the mail source of truth.
- [ ] A logical export, if required, followed the FTS-aware procedure in
  [docs/DEPLOYMENT.md](./DEPLOYMENT.md): verify, prepare, export during a write
  freeze, restore the virtual layer, and verify again.
- [ ] No Time Travel restore was run during ordinary release work. Restore is
  an incident-only destructive operation requiring separate approval.

## Code and preflight gates

- [ ] `bun run check` passes.
- [ ] `bun test src scripts` passes.
- [ ] `bun run build` passes.
- [ ] `bun run release:preflight -- --json` passes with no `FAIL` checks.
- [ ] `bun run deploy:dry-run` passes without reading the private config or
  publishing a Worker.
- [ ] `git diff --check` passes.
- [ ] If UI behavior changed, the isolated local browser gates were run:

  ```bash
  bun run test:e2e
  bun run test:e2e:webkit
  bun run test:a11y
  ```

- [ ] Local, mock, browser and CI evidence is labeled as such; none is claimed
  as proof of Cloudflare production capacity, Resend delivery, Email Routing,
  production webhook registration or real-device Safari.

## First deployment or production runtime changes

- [ ] Email Routing remains disabled while the bootstrap Worker is deployed.
- [ ] The bootstrap Worker was created with `bun run deploy` from the exact
  release SHA and private config.
- [ ] The Custom Domain was attached and resolves to the intended Worker:

  ```text
  Workers & Pages → flaremail → Settings → Domains & Routes
  → Add → Custom Domain
  ```

- [ ] Resend sending domain DNS is verified; SPF is merged into one SPF record,
  DKIM uses the dashboard-generated selector/target, and DMARC is reviewed.
- [ ] Resend webhook endpoint is exactly
  `https://<APP_ORIGIN_HOST>/api/webhooks/resend`.
- [ ] The webhook subscribes to the code-supported events:
  `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`,
  `email.failed`, `email.complained`, and `email.suppressed`. `email.opened`
  and `email.clicked` are timeline-only events in the current code.
- [ ] Both Resend secrets were uploaded with the final code using
  `bun x wrangler deploy --secrets-file <secure-outside-repo-path>` so
  code/config/bindings/secrets form one reviewed release. If the fallback
  `secret put` process was used, Email Routing remained disabled while the
  intermediate versions were incomplete and a final `bun run deploy` followed.
- [ ] `GET https://<APP_ORIGIN_HOST>/api/health` returns HTTP 200.
- [ ] Email Routing **Destination Addresses** contains an operator-controlled
  mailbox whose verification email was completed. This is Cloudflare's setup
  destination, not the incoming FlareMail recipient.
- [ ] Only after health and dependency review passed was Email Routing enabled:

  ```text
  Email Routing → Enable/Get started → Destination Addresses → verify
  → Routing Rules → Create address
  → Send to a Worker → flaremail
  ```

- [ ] The active rule is not shadowed by a higher-priority catch-all or
  forwarding rule. It sends to a Worker, not **Forward to email**.

## Production smoke

- [ ] Inbound smoke reached Worker `email()`, created a D1 row with the correct
  owner, wrote raw/body/attachment objects to the production R2 bucket, and
  displayed the message in the administrator Inbox.
- [ ] Inbound UTF-8/Chinese text, sender, subject, threading, raw `.eml`, plain
  text, sanitized HTML, attachment download, size and SHA-256 integrity passed.
- [ ] Expected inbound size/MIME rejects did not become Worker failures.
- [ ] Outbound smoke reached Resend from the verified domain and first reported
  local state `submitted` with a provider message ID.
- [ ] A valid signed `email.delivered` webhook changed the local state to
  `delivered`. API acceptance or `email.sent` alone was not counted as delivery.
- [ ] Bounce, delayed, failed, complained and suppressed events were reviewed;
  duplicate/out-of-order events did not move delivery state backwards.
- [ ] `/api/health = 200` was not used as proof of login, inbound, R2,
  outbound, webhook or mailbox delivery.
- [ ] Evidence contains no secrets, message body, raw MIME or complete R2 key.

## Rollback readiness and incident recovery

- [ ] Current and previous known-good Worker SHAs/versions are recorded.
- [ ] The production D1 target, schema version and pre-change Time Travel
  bookmark are recorded.
- [ ] Production D1/R2 binding names, Resend webhook endpoint/event set,
  Email Routing rule and secret-present status are recorded without values.
- [ ] Normal code rollback will deploy the previous Worker while preserving
  append-only D1 schema, cleanup/delivery evidence and canonical R2 objects.
- [ ] No older Worker rollback plan requires dropping new D1 columns or deleting
  raw mail, body or attachment objects.
- [ ] Any D1 restore has a separate incident approval and a reviewed bookmark or
  timestamp. The operator understands that restore overwrites D1 and cancels
  in-flight queries.
- [ ] After rollback/restore, health, schema metadata, FTS projection/index,
  cleanup queue, attachment integrity, delivery reconciliation and R2
  references will be reverified before traffic is reopened.
