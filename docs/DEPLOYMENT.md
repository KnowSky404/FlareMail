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
sessions, stale inbound claims, delivery review windows, old `workspace_outbound_events`, and R2 objects that are not
referenced by `email_messages.raw_key` or `workspace_attachments.r2_key`:

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

`--apply` deletes only managed `inbound/YYYY-MM-DD/<id>/...` keys that are
unreferenced. Other key shapes are reported and skipped. The command never
executes a remote operation unless `--remote` is supplied, and never executes
any deletion unless `--apply` is supplied.

Before production maintenance, export D1 and record the current commit. Keep
the export in a protected operator directory and inspect the dry-run output.
Production deployment and remote migration remain separate, explicitly
authorized operations.

## Schema, claims, and delivery review

Migration `0009_inbound_ingest_claims.sql` adds the project-owned
`workspace_schema_metadata` version marker and the inbound claim lease.
Migration `0010_mailbox_archive_and_bulk.sql` append-only adds `archived_at` and
the mailbox indexes used by archive and bulk actions. Apply migrations in order;
do not edit `0001` through `0010`. A stale claim report is
read-only by default. Review the claim age and D1/R2 evidence before using the
explicit `--apply` path to remove stale processing claims.

The maintenance report also lists stale submitting attempts, attempts within
one hour of the Resend 24-hour idempotency expiry, and expired attempts that
require review. A normal retry after expiry returns
`DELIVERY_REVIEW_REQUIRED`; inspect Resend Dashboard, the inbox, and the
delivery timeline before choosing any separately authorized resend workflow.
