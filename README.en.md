# FlareMail

<p align='center'>
  <img src='./static/brand/flaremail-logo.svg' alt='FlareMail logo' width='286' />
</p>

FlareMail is a personal, self-hosted mail workspace on Cloudflare Workers. One stable Owner manages explicitly configured domains and mail addresses; addresses are mail resources, not login accounts. One Worker composition root serves the SvelteKit web/API `fetch()` handler and Cloudflare Email Routing `email()` handler. D1 stores structured state, R2 stores raw `.eml` objects and attachments, and production outbound mail uses Resend.

The repository is pinned to Bun `1.4.0`. The application preserves the existing authentication, mail, D1, R2, Email Routing, Resend, Telegram, draft, and owner-isolation contracts.

## Implemented capabilities

- Inbound Email Routing with streamed raw-message limits, SHA-256 deduplication, RFC threading, MIME, Unicode, and attachment parsing.
- D1/R2 persistence for inbound mail, attachments, ownership, read/star state, archive/trash actions, drafts, sent mail, delivery state, and event timelines. Downloads verify ownership, size, and checksum before returning bytes.
- Resend outbound delivery with stable idempotency keys, reply/RFC headers, streamed R2 attachments, error classification, retries, and separate submitted/delivered semantics.
- Explicit `AUTH_MODE=local|cloudflare-access` authentication: a non-email local username and PBKDF2 password, or a verified Cloudflare Access identity mapped to the same stable Owner. Both modes retain revocable D1 sessions, secure cookies, Origin/CSRF validation, login rate limiting, and security headers.
- Multi-domain mail identities: domains enter through a controlled configuration flow, and address routing uses exact Cloudflare Email Routing Rules in explicitly selected zones. Inbound ownership is resolved from the envelope recipient before body parsing or R2 writes. Inbox filters apply server-side to mail, drafts, search, counts, and pagination. Bulk actions default to selected loaded messages; filtered-thread and Owner-wide thread expansion require an explicit choice. Trash is always an Owner-wide view.
- Multiple sender identities: new mail, replies, drafts, and retries carry a managed address ID. The server checks Owner, address state, and the domain's Resend sending verification, then freezes the From/signature snapshot. Legacy `OUTBOUND_FROM_EMAIL` / `MAIL_FROM` values are only for system auto-replies and notifications.
- Reading-first responsive workspace with a collapsible sidebar, a 280–480 px mouse or keyboard adjustable mail list, standard/compact density, desktop three-column reading, tablet/mobile drill-in, near-fullscreen focused reading, and an owner-scoped `/messages/[id]` standalone reader route. The list temporarily contracts when the detail pane needs its minimum space, Enter resets it to the 360 px default, and same-user windows exchange state signals without broadcasting bodies, addresses, or credentials.
- Full zh-CN/en product UI. The server chooses an explicit locale or browser-following preference from the safe locale cookie, then `Accept-Language`; the browser can switch to either mode and persist it. Dates, numbers, counts, and accessibility labels follow the effective locale while user mail content stays unchanged.
- Telegram notification binding with one deployment bot, private per-workspace binding, one-time confirmation links, privacy controls, durable D1 outbox, cron delivery, retry/backoff state, and existing message links. See [docs/TELEGRAM.md](./docs/TELEGRAM.md).

## Environment boundaries

| Environment | Outbound provider | Data and credentials | Constraint |
| --- | --- | --- | --- |
| development/test | Explicit `demo`/fake | Local D1/R2; bootstrap required | Set `ALLOW_FAKE_SERVICES=true` |
| preview | Private configuration | Isolated preview resources | Do not reuse production credentials or D1 |
| production | `resend` only | Real D1/R2 and Wrangler secrets | Missing bindings/secrets fail closed |

The repository contains no fixed login password. Use `scripts/bootstrap-admin.ts` with `FLAREMAIL_ADMIN_USERNAME` and environment variables in the current shell; an optional `FLAREMAIL_PROFILE_EMAIL` is profile data and grants no mail identity. Access-only initialization uses `bun run auth:bootstrap:access` and does not require a local password.

Migrations `0023`–`0026` separate the stable Owner from local credentials, add managed domains/addresses and message identity snapshots, add independent Cloudflare/Resend health-check leases, and persist the address deletion policy. Historical login/profile emails are not automatically granted send or receive rights. Scheduled checks reuse the Telegram Cron, select only due domains, preserve prior successful timestamps on provider errors, and report privately through `/api/readiness`. A previously verified explicit `collect` domain receives at most 24 additional hours of bounded collection grace after transient Cloudflare health errors; its successful timestamp is not extended. Address deletion includes a read-only route/catch-all preview and can retain a verified exact FlareMail route so a deleted tombstone rejects that address before catch-all handling; imported rules stay untouched. Removing the exact rule cannot block a separate external catch-all. See the [architecture ADR](./docs/adr/0014-owner-managed-mail-identities-and-access.md) and [deployment guide](./DEPLOY.md).

Historical address association keeps the read-only `mail:identity:dry-run` audit and adds an explicit local plan/apply/verify workflow. It maps only inbound envelope recipients whose existing owner already matches the selected stable Owner and address. Old outbound `From` snapshots and drafts are not inferred or rewritten. Plans bind the schema, target IDs, 24-hour expiry, and isolated local D1 persistence path; the tool rejects `--remote`.

## Local verification

```bash
bun install --frozen-lockfile
bun run db:migrate:local
bun run check
bun run test
bun run build
bun run test:e2e
bun run test:e2e:webkit
bun run test:a11y
```

Browser checks use isolated local D1/R2 state and fake providers. Linux Playwright WebKit is not evidence for a real iOS/iPadOS Safari device. If Playwright browser binaries are absent, the browser commands fail before launch; that is an environment blocker separate from build and unit-test results.

The reading-space-specific dimensions and current browser evidence are recorded in [docs/READING_SPACE_QA.md](./docs/READING_SPACE_QA.md).

Production deployment, remote migrations, real mail smoke tests, and real Telegram delivery require an explicit operational decision. See [DEPLOY.md](./DEPLOY.md), [DESIGN.md](./DESIGN.md), and [TODO.md](./TODO.md).
