# FlareMail runtime budget

FlareMail combines SvelteKit SSR, Cloudflare Email Routing, D1, R2, MIME parsing,
attachment handling, hashing, and Resend calls in one Worker composition root.
The recommended production target for this architecture is Workers Paid. The
Workers Free plan is supported only as best-effort after a real remote preview
measurement; local wall time is not a substitute for Cloudflare `cpuTime` or
invocation outcome.

Do not lower PBKDF2 password-hash strength to fit a plan limit. If a workload is
too expensive, change the deployment plan or workload shape deliberately and
record the evidence.

## Persisted text and object budgets

- D1 `TEXT`/`BLOB` and row limits are treated as 2 MB hard ceilings. FlareMail
  keeps mail-body projections far below them: 128 KiB text, 64 KiB HTML, and a
  4 KiB snippet. Bounds use encoded UTF-8 bytes, not JavaScript `.length`.
- Compose text is limited to 8 MiB UTF-8 so request parsing, canonical JSON,
  hashing, and provider serialization remain below the 128 MiB Worker isolate
  memory ceiling. The bounded JSON request reader also caps observed bytes.
- Canonical large bodies are stored in R2 with a 32 MiB encoded-envelope cap;
  D1 stores the pointer, byte counts, digest, and bounded projections.
- Mailbox list and SSR queries do not select body columns. Owned body routes
  perform lazy R2 reads and integrity checks.
- R2 orphan deletion is disabled in ordinary maintenance runs. Apply mode also
  requires a separately reviewed manifest and only recognizes repository-owned
  key shapes.

## Manual preview measurement

This repository does not run a remote benchmark automatically. An operator
should use an isolated preview Worker and preview D1/R2 resources, then:

1. generate deterministic local MIME inputs without contacting any remote
   service:

   ```bash
   bun run runtime:fixtures -- --output ./flaremail-runtime-fixtures
   ```

   The directory contains 1 MiB, 5 MiB, and near-25 MiB raw-message fixtures.
2. deploy the exact tested commit to the preview Worker and verify `/api/health`;
3. use Workers Logs or `wrangler tail` and record `cpuTime`, duration,
   invocation outcome, and any `exceededCpu` event;
4. test login (successful and rejected), an SSR mailbox request, and inbound
   MIME fixtures at approximately 1 MiB, 5 MiB, and near the configured limit;
5. separately observe D1, R2, parser, and Resend failure outcomes.

The application emits structured, non-sensitive phase timing events. They may
contain a correlation ID, byte/count totals, status code, and duration only;
they must not contain credentials, headers, message bodies, recipients, or
addresses.

Remote benchmark, real deploy, remote migration, Email Routing smoke test, and
real Resend sending are intentionally not part of this repository verification.
Production outbound remains Resend; this phase does not switch to Email Sending.
