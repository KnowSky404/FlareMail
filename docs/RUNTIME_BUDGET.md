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
