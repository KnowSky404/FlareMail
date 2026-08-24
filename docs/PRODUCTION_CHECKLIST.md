# FlareMail production checklist

This checklist is the operator gate for an RC-1 Preview or production release.
Repository tests do not authorize or perform a deployment, remote migration,
real email, webhook registration, R2 deletion, alert change, or Cron creation.

Record every command, timestamp, target, and result in the release evidence.
Never paste secrets, cookies, email bodies, recipient addresses, raw MIME, or
complete R2 keys into that evidence.

## Release identity

- [ ] Record `git rev-parse HEAD` as the immutable release SHA.
- [ ] Confirm the branch is `codex/flaremail-rc1-hardening` and its base is
  `04b840e7548e329b1f1d07efc1e6c772e61a8f2d`.
- [ ] Confirm `git status --short` is empty and the SHA exists on `origin`.
- [ ] Confirm every required GitHub Actions job passed for that exact SHA.
- [ ] Confirm `bun.lock` is committed and `bun install --frozen-lockfile`
  succeeds with Bun 1.3.14.
- [ ] Confirm `bun run audit:dependencies` reports no high or critical
  advisory for the exact lockfile.
- [ ] Archive the redacted outputs of `bun run release:preflight -- --json`,
  `bun run search:index -- --mode verify --json`, and the browser jobs.

## Before any remote change

- [ ] Name the target explicitly: isolated Preview or production. Stop if a
  Preview command resolves to a production D1 database, R2 bucket, Worker,
  Resend key/domain, or webhook.
- [ ] Review the private Wrangler configuration without printing secrets.
  Production must use HTTPS `APP_ORIGIN`, `APP_ENV=production`,
  `OUTBOUND_PROVIDER=resend`, the official Resend API origin, and distinct D1
  and R2 bindings. Demo/fake services are forbidden.
- [ ] Confirm `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` are configured as
  secrets. Record only present/missing status.
- [ ] Confirm the Resend sending domain is verified and the intended From,
  Reply-To, bounce, and webhook domains are controlled by the operator.
- [ ] Confirm Email Routing targets only the intended Worker and test address.
- [ ] Confirm `/api/health` is not used as proof of authenticated mail flow.
- [ ] Record the currently deployed Worker version/SHA as the rollback target.
- [ ] Record a bounded R2 inventory summary by managed prefix and object count;
  do not export filenames or complete keys into shared logs.
- [ ] Confirm cleanup backlog, manual-review jobs, stale inbound claims, stale
  attachment uploads, and stuck delivery attempts are understood. A growing or
  unexplained backlog blocks release.

## D1 backup and migration

D1 Time Travel is always on for supported production databases. Before a
migration, record the current bookmark with an explicitly reviewed Wrangler
command and retain it with the release evidence:

```bash
bun x wrangler d1 info flaremail-db --remote --config wrangler.deploy.toml
bun x wrangler d1 time-travel info flaremail-db --remote --config wrangler.deploy.toml
```

- [ ] Confirm the D1 backend supports Time Travel and record the pre-migration
  bookmark. Do not run `time-travel restore` during normal release work; restore
  is destructive and requires separate incident approval.
- [ ] If a longer-lived logical backup is required, schedule a write freeze.
  D1 export blocks database requests and cannot export a database while an FTS5
  virtual table exists.
- [ ] For logical export, first verify the search projection, explicitly remove
  only the rebuildable virtual FTS layer using the documented maintenance
  command, export, restore the FTS layer, and verify it again. Never drop
  `workspace_search_documents`.
- [ ] Review migrations from `0011` through the latest number. Apply every file
  once, in order; never edit an applied migration or perform a destructive
  downgrade.
- [ ] Apply the remote migration only after a separate operator approval:

  ```bash
  bun run db:migrate:remote
  ```

- [ ] Verify `workspace_schema_metadata` equals the repository schema version
  and all health-required tables exist.
- [ ] Run FTS verify. If missing/orphaned rows are non-zero, investigate first;
  then use an explicitly authorized bounded rebuild and verify again.
- [ ] Run attachment integrity repair in report-only mode. Apply only a bounded
  batch after reviewing owner scope, missing objects, size mismatches, checksum
  mismatches, and the continuation cursor.
- [ ] Run cleanup report. Do not release while unsafe keys, lost claims, or
  unexplained `manual_review` jobs exist.

For local or isolated Preview evidence, use the fail-closed commands below.
They refuse production targets; production mutation requires a separately
reviewed operator procedure and approval.

```bash
bun run attachment:integrity -- --limit 100 --json
bun run maintenance -- cleanup-report --config wrangler.toml --json
bun run maintenance -- cleanup-drain --dry-run --limit 50 --config wrangler.toml --json
```

For Preview, add `--remote --config wrangler.preview.toml` only after confirming
that config declares `APP_ENV=preview` and isolated Preview D1/R2 resources.
Only an approved bounded Preview repair/drain may add `--apply`.

## Isolated Preview measurement

- [ ] Deploy the exact release SHA to an isolated Preview Worker with separate
  D1, R2, Resend test credentials, Email Routing address, and webhook.
- [ ] Generate deterministic runtime fixtures locally and record each fixture
  SHA-256. Large generated files remain outside Git.
- [ ] Run the local measurement harness and record its phase timing only as
  local harness evidence, never as Workers CPU or memory evidence.
- [ ] In Workers Logs/Traces and the Cloudflare dashboard, record `cpuTime`,
  wall time, invocation outcome, `exceededCpu`/`exceededMemory`, startup time,
  subrequests, D1 requests, and R2 operations for small, medium, near-limit,
  multipart, HTML/CID, mismatched-length, and attachment-integrity fixtures.
- [ ] Record exact SHA, Preview Worker, fixture hash, UTC time, Cloudflare plan,
  compatibility date, and result. Apply the thresholds in [SLO.md](./SLO.md).

## Preview smoke

Run these against isolated data. Any unexpected 5xx, integrity failure,
cross-owner result, unbounded latency, or PII-bearing log blocks production.

- [ ] Login succeeds; bad credentials are generic and rate limited; logout
  revokes the session; stale/forged sessions fail closed.
- [ ] Compose with multiple To/CC/BCC recipients, refresh autosave, then send.
  Verify BCC is never exposed in recipient-visible headers or API responses.
- [ ] Receive a routed email and verify ownership, plain text, RFC threading,
  Reply, Reply All, Forward, and deduplication.
- [ ] Open sanitized HTML; verify scripts/forms/event handlers are absent,
  remote images require per-message consent, and owned CID images render.
- [ ] Open a canonical large body from R2 and verify size/checksum failure paths.
- [ ] Upload, rename, cancel, retry, refresh, send, and download attachments.
  Test valid, missing, size-mismatched, checksum-mismatched, and legacy-null
  inbound objects without returning corrupt bytes.
- [ ] Search owner-scoped ASCII/UTF-8 content and advanced filters; verify no
  BCC/body/attachment leakage, trash visibility, stable pagination, and zero
  missing/orphan projections.
- [ ] Move to trash, undo, restore, permanently delete, and drain one bounded
  cleanup batch. Verify retry/backoff/manual-review behavior without full keys
  in logs.
- [ ] Submit outbound mail and reconcile signed duplicate/out-of-order webhook
  events. Verify delayed/bounced/complained/suppressed monotonicity.
- [ ] Verify `/api/health`, runtime degraded UI, global mailbox/delivery counts,
  toast semantics, accessibility, Chromium, and Playwright WebKit projects.
- [ ] Manually test a real iPhone and iPad: safe areas, dynamic viewport,
  keyboard/IME, file picker, download, focus restoration, touch targets,
  drawers/dialogs, theme, and horizontal overflow. Linux Playwright WebKit is
  not proof of real-device Safari behavior.

## Production change and smoke

Production commands and real messages are operator-only and are not run by CI.

- [ ] Reconfirm the exact SHA, backup bookmark, target bindings, current
  cleanup/search/integrity reports, and approved maintenance window.
- [ ] Apply migrations before deploying code that requires the new schema.
- [ ] Deploy the exact approved SHA. Do not rebuild from a different checkout.
- [ ] Register or update Email Routing and the Resend webhook only if separately
  approved; preserve the previous configuration for rollback.
- [ ] Run one controlled login, inbound, outbound, webhook, attachment,
  search, trash, cleanup-report, and health smoke. Use designated test mailboxes
  and remove evidence that contains message data.
- [ ] Watch Workers, D1, R2, Resend, cleanup backlog, search drift, attachment
  integrity failures, and the external uptime probe through the release window.

## Rollback

- [ ] Roll back the Worker to the recorded previous version/SHA.
- [ ] Keep append-only tables and columns. Never downgrade or delete D1 schema
  merely because older Worker code is restored.
- [ ] Do not blindly delete R2 canonical objects. Preserve raw messages, bodies,
  attachments, and cleanup jobs until ownership and references are reviewed.
- [ ] Pause any operator-driven cleanup drain; production Cron is not created by
  this release.
- [ ] Disable or restore webhook, Resend, and Email Routing changes only when
  they caused the incident and the prior configuration is known.
- [ ] If data restoration is required, use the recorded Time Travel bookmark
  only under incident approval; restoration overwrites D1 in place and cancels
  in-flight queries.
- [ ] After rollback or restore, verify schema metadata, FTS projection/index,
  cleanup queue, attachment integrity backlog, delivery reconciliation, and R2
  canonical references before reopening normal traffic.
