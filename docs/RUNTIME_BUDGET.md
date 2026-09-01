# FlareMail runtime budget

FlareMail combines SvelteKit SSR, Cloudflare Email Routing, D1, R2, MIME parsing,
attachment handling, hashing, and Resend calls in one Worker composition root.
The recommended production target for this architecture is Workers Paid. The
Workers Free plan is supported only as best-effort after a real remote preview
measurement; local wall time is not a substitute for Cloudflare `cpuTime` or
invocation outcome.

Authentication uses scrypt with `N=2^16`, `r=8`, and `p=2`: OWASP's 64 MiB
profile and a combination verified in a real Workers remote preview. Workers
rejects the previous 600,000-iteration PBKDF2 policy at runtime because its
PBKDF2 implementation is capped at 100,000 iterations. Do not lower password-
hash strength to fit a plan limit. If a workload is too expensive, change the
deployment plan or workload shape deliberately and record the evidence.

## Persisted text and object budgets

- D1 `TEXT`/`BLOB` and row limits are treated as 2 MB hard ceilings. FlareMail
  keeps mail-body projections far below them: 128 KiB text, 64 KiB HTML, and a
  4 KiB snippet. Bounds use encoded UTF-8 bytes, not JavaScript `.length`.
- Compose text is limited to 8 MiB UTF-8 so request parsing, canonical JSON,
  hashing, and provider serialization remain below the 128 MiB Worker isolate
  memory ceiling. The bounded JSON request reader also caps observed bytes.
- Canonical large bodies are stored in R2 with a 32 MiB encoded-envelope cap;
  D1 stores the pointer, byte counts, digest, and bounded projections.
- Outbound attachments are streamed individually to R2 with a per-file 8 MiB
  limit, a 10-file limit, and a 12 MiB raw total. Send/retry reads and hashes
  the owned objects before building Resend's Base64 JSON payload. The 12 MiB
  total stays below Resend's 40 MB encoded-email cap and leaves isolate-memory
  headroom for the byte and Base64 copies; preview measurements must still
  cover the upper bound before production enablement.
- Inbound MIME parsing already materializes each accepted attachment within a
  15 MiB per-file and 24 MiB aggregate attachment budget. Ingest hashes those
  bounded bytes before R2/D1 finalization. A verified download reads at most one
  15 MiB object into memory, checks actual size and SHA-256, and only then
  returns bytes. This is intentionally below the 128 MiB isolate ceiling but
  still requires the near-limit Preview measurement because parser, digest,
  response, and runtime overhead coexist.
- Mailbox list and SSR queries do not select body columns. Owned body routes
  perform lazy R2 reads and integrity checks.
- FTS5 indexes only bounded projections: 8 KiB from, 16 KiB To/CC, 4 KiB
  subject, 64 KiB body text and 16 KiB labels per document. The projection
  excludes BCC, raw MIME, attachment bytes, secrets and full R2 bodies.
- Advanced search binds one parser-generated FTS expression and uses fixed
  relational predicates for flags, dates, attachment existence and delivery
  status. The first page computes an exact result total outside the FTS
  `snippet()` query; later pages retain that total without another count.
- R2 orphan deletion is disabled in ordinary maintenance runs. Apply mode also
  requires a separately reviewed manifest and only recognizes repository-owned
  key shapes.

## Manual preview measurement

This repository does not run a remote benchmark automatically. An operator
should use an isolated preview Worker and preview D1/R2 resources, then:

1. generate deterministic local MIME inputs without contacting any remote
   service:

   ```bash
   bun run runtime:fixtures
   ```

   The directory contains deterministic 1 MiB, 5 MiB, near-raw-limit,
   near-15-MiB inbound attachment, near-12-MiB outbound aggregate,
   multi-attachment, HTML/CID, mismatched-length, checksum-mismatch, and
   deeply nested multipart fixtures. Each contains a stable
   `X-FlareMail-Runtime-Correlation` value and a recorded SHA-256.
2. execute the local parser measurement without contacting Cloudflare:

   ```bash
   bun run runtime:measure
   bun run runtime:measure -- --json
   ```

   This invokes the production MIME parser and reports fixture bytes, local
   parser wall duration, bounded result/error category, and correlation ID.
   D1, R2, upload, download, and send-preparation fields remain explicitly
   `preview_required`; the command never fabricates Workers CPU, memory, or
   subrequest values.
3. deploy the exact tested commit to the preview Worker and verify `/api/health`;
4. use Workers Logs or `wrangler tail` and record `cpuTime`, duration,
   invocation outcome, and any `exceededCpu` event;
5. test login (successful and rejected), an SSR mailbox request, and inbound
   MIME fixtures at approximately 1 MiB, 5 MiB, and near the configured limit;
6. separately observe D1, R2, parser, and Resend failure outcomes.
7. upload files near the 8 MiB per-file and 12 MiB total outbound limits, then
   record R2 put, integrity-read, serialization, and provider-call timings;
8. run `bun run search:index -- --mode verify --json` and record projection
   counts; use a reviewed rebuild only if drift is reported.

The application emits structured, non-sensitive phase timing events. They may
contain a correlation ID, byte/count totals, status code, and duration only;
they must not contain credentials, headers, message bodies, recipients, or
addresses.

Remote benchmark, real deploy, remote migration, Email Routing smoke test, and
real Resend sending are intentionally not part of this repository verification.
Production outbound remains Resend; this phase does not switch to Email Sending.
