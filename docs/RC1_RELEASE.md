# FlareMail RC-1 release record

## Identity

- Baseline branch: `codex/flaremail-next-release`
- Baseline SHA: `04b840e7548e329b1f1d07efc1e6c772e61a8f2d`
- RC branch: `codex/flaremail-rc1-hardening`
- Release SHA: the immutable Pull Request head reported by
  `git rev-parse HEAD` and verified by GitHub Actions. Record it in the release
  evidence immediately before approval; a commit cannot safely contain its own
  final SHA.
- Previous-stage baseline: `312af6313dd5f4ecfcc2fd3e8064f1c5f89f9d14`

## Scope and behavior changes

RC-1 preserves the single-Worker SvelteKit/Email Routing composition, D1
domain state, R2 canonical objects, Resend outbound provider, owner-scoped
workspace, and existing UI. This hardening release adds:

- clean-checkout PR gates for frozen installs, high-severity dependency audit,
  separated Bun suites, generated types, build, secret-free deploy dry-run,
  search verification, Chromium, WebKit smoke, and accessibility evidence;
- one read-only-by-default release preflight with stable human/JSON results;
- SHA-256 persistence and verified download for inbound attachments, plus a
  bounded report/apply legacy repair path;
- a durable cleanup job lifecycle with scoped claims, leases, retry/backoff,
  maximum attempts, completed/manual-review states, bounded drain, and safe
  backlog summaries;
- deterministic near-limit runtime fixtures and a local measurement harness
  that does not claim to measure Workers CPU or isolate memory;
- targeted Desktop WebKit, iPhone-size, and iPad-size Playwright smoke, while
  retaining real-device Safari as a manual release gate;
- bounded webhook reads, stricter production cookie selection, reliable logout
  revocation, cursor/query binding, runtime status semantics, and focused
  regression tests;
- the operator checklist and proposed SLO/observability contract.

## Schema and compatibility

Migrations `0011` through `0016` remain byte-for-byte unchanged. Migration
`0016_outbound_attachments.sql` already supplies the nullable `sha256` column
used for both existing outbound and new inbound integrity metadata, so legacy
inbound rows remain readable through size checks until repaired.

RC-1 adds `0017_r2_cleanup_queue_reliability.sql` and advances schema version to
17. It adds queue status, attempts, next-attempt time, claim/lease metadata,
safe error category, completion time, object kind, and source ownership scope.
Existing queue rows are conservatively migrated to `manual_review`/`legacy`;
they are never auto-deleted. Older Worker versions may ignore the new columns,
so rollback keeps the upgraded D1 schema and canonical R2 objects rather than
attempting a destructive downgrade.

## Configuration and API impact

- No production secret, resource identifier, bucket name, or private Wrangler
  file is added to Git.
- Production still requires `APP_ENV=production`, HTTPS `APP_ORIGIN`, D1/R2,
  Resend secrets, and `OUTBOUND_PROVIDER=resend`; fake providers fail closed.
- The public product surface remains compatible. Integrity failures now return
  controlled missing/size/checksum errors and never return corrupt bytes.
- Maintenance and repair mutations require explicit environment and apply
  flags. Their defaults are local, bounded, report-only, and PII-free.
- Production Cron is not created. Any future scheduled trigger requires an
  operator-reviewed configuration and rollback plan.

## Verification contract

The PR is releasable only if the exact head passes:

```bash
bun install --frozen-lockfile
bun run audit:dependencies
bun test
bun run test:unit
bun run test:integration
bun run test:remaining
bun run check
bun run cf:typegen -- --check
bun run build
bun run deploy:dry-run
bun run search:index -- --mode verify --json
bun run release:preflight
bun run release:preflight -- --json
bun run test:e2e
bun run test:e2e:webkit
bun run test:a11y
git diff --check
```

Local, mock, Playwright, and CI results prove only their named environments.
They do not prove Cloudflare production capacity, Resend delivery, Email
Routing, production webhook registration, real-device Safari, or remote data
correctness.

## Operator-only work not performed by this release

- production or Preview deployment;
- remote D1 migration, Time Travel restore, logical export, or FTS mutation;
- production D1/R2 reads or writes and cleanup drain;
- real Resend send, Email Routing receive, or webhook registration;
- production alert/SLO configuration or Cron creation;
- real iPhone/iPad verification and Cloudflare runtime measurement.

Follow [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md) in order. Record the
exact SHA, CI URL, D1 bookmark, Preview resources, fixture hashes, runtime
evidence, smoke results, and rollback Worker. Do not promote a Preview result
obtained from shared production data or credentials.

## Residual risks and non-goals

- Local duration/RSS evidence cannot predict Workers CPU, isolate memory,
  subrequests, or concurrent-isolate pressure; near-limit Preview evidence is a
  blocking manual gate.
- Playwright WebKit on Linux is not real iOS/iPadOS Safari evidence.
- Legacy attachment rows remain in a degraded size-only state until a bounded
  repair batch records their checksum; report and trend this backlog.
- R2 deletion can succeed before a D1 completion write fails. Leases and
  idempotent replay make recovery safe, but the backlog still needs operators
  and alerting.
- FTS5 virtual tables prevent ordinary full D1 logical export. Time Travel is
  preferred; the projection must be preserved and FTS rebuilt after an
  approved export/restore flow.

Durable outbox/Queues/DLQ, undo send, scheduling, rich-text compose, contacts,
labels CRUD, saved search, snooze/rules/templates, multiple identities, PWA,
push, full export, open registration, and multi-user RBAC remain out of scope.

## Rollback summary

Restore the previous Worker version while retaining append-only D1 changes and
R2 canonical objects. Pause cleanup application, preserve queued evidence,
review webhook/Email Routing/Resend changes separately, and use D1 Time Travel
only under explicit incident approval. Then verify health, schema metadata,
FTS, integrity backlog, cleanup jobs, delivery reconciliation, and ownership.
