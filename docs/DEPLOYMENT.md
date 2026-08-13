# FlareMail deployment and maintenance

`wrangler.toml` is the local development template. Copy
`wrangler.deploy.toml.example` to the private `wrangler.deploy.toml`, replace
the D1 and R2 placeholders, and keep that file out of Git.

Both templates enable Workers Observability logs and traces. Development uses
25% log sampling and 5% trace sampling; the deployment template uses 50% log
sampling and 5% trace sampling. Application logs contain correlation IDs and
stable internal IDs only. Do not add credentials, email bodies, raw headers,
R2 object contents, or access tokens to logs.

## Maintenance CLI

The maintenance command is read-only by default. It reports expired/revoked
sessions, old `workspace_outbound_events`, and R2 objects that are not
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
