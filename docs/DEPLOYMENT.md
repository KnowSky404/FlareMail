# FlareMail maintenance and recovery procedures

The complete first-deployment and ordinary upgrade flow is
[DEPLOY.md](../DEPLOY.md). This document is intentionally focused on
read-only-by-default maintenance, FTS-aware export, cleanup and incident
recovery. It does not authorize production operations by itself.

`wrangler.toml` is the local development template. Copy
`wrangler.deploy.toml.example` to the private `wrangler.deploy.toml`, replace
the D1 and R2 placeholders, and keep that file out of Git.

Remote maintenance inherits the operator's normal Wrangler OAuth keyring or
`CLOUDFLARE_API_TOKEN` environment. It does not redirect the Wrangler config
directory. Authenticate with `bun x wrangler login --use-keyring` (add
`--device` for a remote terminal when needed), then verify the active identity
with `bun x wrangler whoami` before any explicitly authorized remote command.

Both templates enable Workers Observability logs and traces. Development uses
25% log sampling and 5% trace sampling; the deployment template uses 50% log
sampling and 5% trace sampling. Application logs contain correlation IDs and
stable internal IDs only. Do not add credentials, email bodies, raw headers,
R2 object contents, or access tokens to logs.

## Maintenance CLI

The maintenance command is read-only by default. It reports expired/revoked
sessions, stale inbound claims, delivery review windows, old `workspace_outbound_events`, durable
`workspace_r2_cleanup_queue` retries, and R2 objects that are not referenced by
live mail/body/attachment metadata:

```bash
bun scripts/maintenance.ts --config wrangler.toml
bun scripts/maintenance.ts --remote --config wrangler.deploy.toml --json
```

Retention defaults are 30 days for sessions and 180 days for webhook events.
Adjust them explicitly with `--session-retention-days N` and
`--webhook-retention-days N`.

R2 inventory is deliberately explicit. Use a reviewed JSON manifest for local
or offline runs:

```json
{"objects":[{"key":"inbound/2026-08-01/example/message.eml"}]}
```

Remote runs also require an explicitly generated and reviewed inventory. The
CLI does not infer an object list or reuse broad Cloudflare credentials. If no
inventory is supplied, R2 is reported as unavailable and no R2 object can be
deleted.

Review a dry-run report first. Applying D1 and R2 cleanup requires the separate
`--apply` flag:

```bash
bun scripts/maintenance.ts --remote --config wrangler.deploy.toml --r2-manifest /secure/reviewed-r2-inventory.json --json
bun scripts/maintenance.ts --remote --config wrangler.deploy.toml --r2-manifest /secure/reviewed-r2-inventory.json --apply
```

The retention/orphan `--apply` path deletes only unreferenced managed `inbound/YYYY-MM-DD/<id>/...`,
`body/v1/...`, and `outbound/v1/YYYY-MM-DD/<uuid>/<uuid>.bin` keys. Expired
`uploading`/`failed`/`delete_pending` outbound rows stop protecting their objects; after a
reviewed R2 delete, matching expired attachment/body metadata may be removed.
Cleanup queue rows are append-only lifecycle evidence and are never removed by
retention maintenance. Active and
not-yet-expired rows remain references. Other key shapes are reported and
skipped. The command never
executes a remote operation unless `--remote` is supplied, and never executes
any deletion unless `--apply` is supplied.

## Durable cleanup queue

Migration `0017_r2_cleanup_queue_reliability.sql` upgrades the existing queue
with `pending`, `processing`, `retryable`, `completed`, and `manual_review`
states; bounded attempt/backoff metadata; claim tokens and five-minute leases;
completion/error summaries; and source ownership scope. Existing `0016` rows
cannot prove those relations, so migration marks them `legacy/manual_review`
instead of auto-deleting an object.

Use the dedicated commands for local or isolated Preview queue work:

```bash
bun run maintenance -- cleanup-report --config wrangler.toml --json
bun run maintenance -- cleanup-drain --dry-run --limit 50 --config wrangler.toml --json
bun run maintenance -- cleanup-drain --apply --limit 50 --config wrangler.toml --json
bun run maintenance -- cleanup-retry --dry-run --limit 50 --max-attempts 8 --config wrangler.toml --json
```

Remote execution requires both `--remote` and a separately maintained
`APP_ENV=preview` config with Preview D1/R2 resources. The selected bucket is
derived from its `BUCKET` binding; `--bucket` is rejected. A mutation requires
the additional `--apply` flag. These commands refuse production configs, never
process `legacy` keys automatically, never print complete keys, and handle at
most 500 rows per invocation. Production cleanup remains a separately reviewed
operator workflow; the current configuration does not create a Cron trigger.

An R2 delete is followed by a claim-token-guarded D1 completion update. A
temporary delete failure schedules exponential backoff; exhausted or unsafe
jobs enter `manual_review`. If deletion succeeds but finalization fails, the
lease expires and idempotent replay safely retries the missing-object delete.
Completed rows remain as evidence.

## Inbound attachment integrity repair

New inbound attachments persist a lowercase SHA-256 in D1 and R2 put metadata.
Downloads verify owner scope, object existence, actual size, and checksum before
returning bytes. Historical checksum-null rows remain size-checked and can be
audited or repaired in bounded batches:

```bash
bun run attachment:integrity -- --limit 100 --json
bun run attachment:integrity -- --apply --limit 100 --cursor ATTACHMENT_ID --json
```

The default is local/report-only. An isolated Preview run additionally requires
`--remote --config wrangler.preview.toml`; the config must declare
`APP_ENV=preview` plus Preview D1/R2 resources. Replacing a non-null mismatched
digest also requires `--repair-mismatches`. Production configs are refused.
Reports contain internal IDs and stable result categories, never filenames,
addresses, message bodies, object keys, cookies, or credentials.

Before production maintenance, record a current D1 Time Travel bookmark and
the exact commit. Time Travel is automatic on supported production databases;
the current Cloudflare documentation describes a bounded recent history, so
verify availability and retention for the active account at release time.
Restoring a bookmark overwrites D1 in place and is a separately approved
incident action. D1 SQL export does not support databases containing FTS5
virtual tables. Do not run a normal logical export after migration 0015 unless
the explicit FTS export procedure below is in a maintenance window. Production
deployment and remote migration remain separate, explicitly authorized
operations.

## Search index verification and D1 export

`workspace_search_documents` is a bounded, owner-scoped projection of inbound,
sent, and draft text. `workspace_search_fts` is an external-content FTS5 table
that can always be recreated from that projection. Raw MIME, attachment bytes,
BCC and secrets are never indexed.

The index command is local and read-only by default:

```bash
bun run search:index -- --mode verify --json
bun run search:index -- --mode rebuild --apply
```

`verify` reports canonical, projected, missing and orphan counts. `rebuild`
upserts every bounded projection, removes orphan projection rows and asks FTS5
to rebuild its virtual index. Remote use requires both `--remote` and, for a
mutation, `--apply`.

Prefer D1 Time Travel for production rollback evidence:

```bash
bun x wrangler d1 info flaremail-db --config wrangler.deploy.toml
bun x wrangler d1 time-travel info flaremail-db --config wrangler.deploy.toml
```

These commands act on remote production D1; the current Wrangler CLI does not
need a `--remote` flag for `d1 info` or `d1 time-travel`. Record the returned
bookmark without running `time-travel restore`. A logical export is appropriate
only when a longer-lived SQL artifact is explicitly required.

If a logical SQL export is mandatory, stop application writes and use this
sequence. The canonical projection table remains intact while the unsupported
virtual layer is absent:

```bash
bun run search:index -- --mode verify --remote --config wrangler.deploy.toml --json
bun run search:index -- --mode prepare-export --remote --config wrangler.deploy.toml --apply
bun x wrangler d1 export flaremail-db --remote --config wrangler.deploy.toml --output /secure/path/flaremail-logical.sql
bun run search:index -- --mode restore-export --remote --config wrangler.deploy.toml --apply
bun run search:index -- --mode verify --remote --config wrangler.deploy.toml --json
```

If export fails, restore the virtual layer before reopening traffic. After any
SQL import or Time Travel restore, run the reviewed rebuild command. The
current restore command accepts a bookmark or timestamp:

```bash
bun x wrangler d1 time-travel restore flaremail-db \
  --bookmark='<RECORDED_BOOKMARK>' \
  --config wrangler.deploy.toml
```

Time Travel restore overwrites the target database, cancels in-flight queries,
and always requires the recorded pre-change bookmark plus separate operator
approval. It is never part of ordinary deployment.

## Schema, claims, and delivery review

Migration `0009_inbound_ingest_claims.sql` adds the project-owned
`workspace_schema_metadata` version marker and the inbound claim lease.
Migration `0010_mailbox_archive_and_bulk.sql` append-only adds `archived_at` and
the mailbox indexes used by archive and bulk actions. Apply migrations in order;
do not edit `0001` through `0010`. A stale claim report is
read-only by default. Review the claim age and D1/R2 evidence before using the
explicit `--apply` path to remove stale processing claims. Migration
`0015_search_fts.sql` adds the rebuildable FTS projection, virtual index and
canonical-row synchronization triggers. Migration
`0016_outbound_attachments.sql` adds draft/message attachment relations,
upload/ready/failure/delete-pending states, SHA-256 metadata, cleanup deadlines,
and the draft attachment revision used by guarded sends.
Migration `0017_r2_cleanup_queue_reliability.sql` append-only adds the durable
claim/lease/retry/manual-review lifecycle. Migration
`0018_outbound_rate_limits.sql` adds the per-user outbound rate-limit state and
advances the current schema metadata to 18. Do not modify or downgrade
published migrations; rollback restores Worker code while preserving newer D1
columns and queue evidence.

The maintenance report also lists stale submitting attempts, attempts within
one hour of the Resend 24-hour idempotency expiry, and expired attempts that
require review. A normal retry after expiry returns
`DELIVERY_REVIEW_REQUIRED`; inspect Resend Dashboard, the inbox, and the
delivery timeline before choosing any separately authorized resend workflow.
