# FlareMail deployment and maintenance

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

`--apply` deletes only unreferenced managed `inbound/YYYY-MM-DD/<id>/...`,
`body/v1/...`, and `outbound/v1/YYYY-MM-DD/<uuid>/<uuid>.bin` keys. Expired
`uploading`/`failed`/`delete_pending` outbound rows stop protecting their objects; after a
reviewed R2 delete, their matching metadata rows and durable cleanup-queue rows
are removed. Queue entries whose objects are absent from the reviewed manifest
are also reconciled. Active and
not-yet-expired rows remain references. Other key shapes are reported and
skipped. The command never
executes a remote operation unless `--remote` is supplied, and never executes
any deletion unless `--apply` is supplied.

Before production maintenance, create and list a managed D1 backup and record
the current commit. D1 SQL export does not support databases containing FTS5
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

Prefer a managed backup for production:

```bash
bun x wrangler d1 backup create <DATABASE_ID> --name=flaremail-maintenance
bun x wrangler d1 backup list <DATABASE_ID>
```

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
SQL import, backup restore, or Time Travel restore, run the reviewed rebuild
command. Backup restore overwrites the target database and always requires a
fresh backup plus separate operator approval.

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

The maintenance report also lists stale submitting attempts, attempts within
one hour of the Resend 24-hour idempotency expiry, and expired attempts that
require review. A normal retry after expiry returns
`DELIVERY_REVIEW_REQUIRED`; inspect Resend Dashboard, the inbox, and the
delivery timeline before choosing any separately authorized resend workflow.
