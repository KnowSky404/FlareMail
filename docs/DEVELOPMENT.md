# Local development

[Project overview](../README.md) · [简体中文介绍](../README.zh-CN.md) · [Documentation index](./README.md)

## Prepare the checkout

Create a dedicated worktree and task branch before editing, including for
documentation or instruction changes. Keep the user's original checkout intact.
Follow the [worktree and PR workflow](#worktree-and-pr-workflow) below, then run
setup and verification from that worktree.

Use the newest stable Bun already installed on your machine, satisfying
`engines.bun` in `package.json` (currently **>=1.4.0**). Do not download an older
runtime just to match `packageManager`: that field records the reproducible CI
baseline, currently **1.4.2**, and CI reads it directly. Release preflight checks
the stable runtime against the engine minimum, rather than requiring equality
with the CI baseline. This policy does not automatically upgrade the machine's
Bun installation or project dependencies. From the repository root:

```bash
bun --version
bun install --frozen-lockfile
bun run audit:dependencies
bun run db:migrate:local
```

The checked-in `wrangler.toml` uses local D1/R2, `AUTH_MODE=local`, and the demo outbound provider with `ALLOW_FAKE_SERVICES=true`. Optional local overrides belong in the ignored `.dev.vars`; see `.dev.vars.example`. Keep real credentials out of Git.

The workflow is a dedicated worktree and branch, local implementation and
verification, a committed change, authorized remote PRE (Preview) acceptance,
then a PR targeting `main`. Merge and production publication follow their
respective authorizations. Ordinary development does not automatically deploy.
The repository's configured preview environments share production D1/R2 and
the Owner account; writes there affect production. Use local state for
development and read the [preview guide](./PREVIEW.md) before using a remote
preview. Production uses Resend and rejects missing required bindings or secrets.

## Worktree and PR workflow

Inspect the current directory, branch, upstream, status and existing worktrees
before changing anything. For a new task, fetch and inspect the latest
`origin/main`, then create a new branch in a separate checkout. For example,
from the original repository (replace the topic and path for each task):

```bash
pwd
git status --short
git branch --show-current
git rev-parse --abbrev-ref --symbolic-full-name '@{u}'
git worktree list
git fetch origin main
git rev-parse origin/main
git worktree add -b feat/mail-topic ../FlareMail-mail-topic origin/main
cd ../FlareMail-mail-topic
```

Use `fix/<topic>` or `docs/<topic>` for fixes and documentation. A writable
temporary directory is also suitable. Record the absolute worktree path,
branch and base SHA. Resume an existing task in its existing worktree and
branch; use a different base only when the user requests it. Never develop
directly on `main` or switch the user's original checkout to the task branch.
Preserve unrelated changes and retain unmerged worktrees and branches.

Install locked dependencies in the task worktree. Keep generated output,
local D1/R2, browser state and server ports separate from other tasks. Do not
share writable build directories or automatically copy private configs or
credentials from another checkout.

1. Implement and run the applicable local gates below, then create an atomic
   Conventional Commit.
2. With Preview authorization, publish that commit and complete relevant
   business acceptance under [PREVIEW.md](./PREVIEW.md). Record the SHA, URL,
   deployment/version ID, checks and limitations. Health alone is insufficient.
3. Only after PRE acceptance, push the task branch and open a PR targeting
   `main`, within the user's authorization. Include the base SHA, accepted SHA,
   local and PRE evidence, and uncovered behavior. Documentation-only changes
   use diff, command and link review and mark PRE as not applicable.
4. Changes to the implementation after acceptance require affected local gates
   and PRE acceptance again before merge. If PRE is blocked, retain the branch
   and report the blocker; bypassing the gate requires explicit authorization.
   Record alternative verification for handlers PRE cannot exercise.
5. Merge, direct pushes to `main`, and production deployment each require
   authorization covering that action. The default path is an accepted PR
   merged into `main`; an explicitly requested direct push still follows the
   local and PRE gates. Before production, check the final SHA and contents
   against PRE evidence, repeat verification and acceptance if contents changed,
   and follow the exact-commit gates in the
   [production checklist](./PRODUCTION_CHECKLIST.md).

## Initialize the local Owner

There is no default login password. Set these variables in the current shell and choose your own password of at least 12 characters:

```bash
export FLAREMAIL_ADMIN_USERNAME='flower'
export FLAREMAIL_ADMIN_NAME='FlareMail Administrator'
export FLAREMAIL_ADMIN_PASSWORD='replace-with-your-own-long-password'
bun run auth:bootstrap:local
unset FLAREMAIL_ADMIN_USERNAME FLAREMAIL_ADMIN_NAME FLAREMAIL_ADMIN_PASSWORD
```

Keep the password out of project `.env` files. `FLAREMAIL_PROFILE_EMAIL` is optional profile data and grants no send or receive rights. For an Access-only Owner, use `bun run auth:bootstrap:access` with no local username/password variables; configure Cloudflare Access using the [deployment guide](../DEPLOY.md).

## Run the application

Choose the SvelteKit development server for page work or the built Worker preview for Worker handlers and local mail testing:

```bash
bun run dev --host :: --port 5173
```

```bash
bun run preview --ip :: --port 8787
```

`::` enables IPv6 and, on systems with dual-stack sockets, IPv4. On this project's VPS, open `http://oc-de-fra-1.knowsky.uk:5173` or `http://oc-de-fra-1.knowsky.uk:8787`. Check the actual listener with `ss -lntp` if remote access fails; a local-only listener is insufficient for browser access from another machine. `bun run preview` is a local Worker process; it does not publish a remote Preview.

### Test inbound mail locally

The Worker preview runs `email()`; the SvelteKit development server alone does not. Configure a local test domain with `bun run mail:domain:configure`, then add an enabled address through mail identity settings or a test fixture. Follow the domain configuration inputs in `.dev.vars.example`.

POST a complete RFC5322 message as the request body to `/cdn-cgi/handler/email?from=...&to=...`. The body must be raw mail, rather than JSON. The envelope `to` must match an enabled managed address or a verified domain collection policy. Login usernames and profile emails do not determine inbound ownership.

The demo/fake provider validates the UI, persistence, and mail state transitions locally. It does not contact Resend or establish real delivery. Production delivery is tracked through signed Resend webhooks; see [deployment](../DEPLOY.md).

## Verify changes

For code, tests, or runtime configuration changes, run these gates in order
before committing. Pure documentation changes need diff, command and link
review; changes to validation scripts or CI still require the code gates:

```bash
bun run test
bun run check
bun run build
```

For browser interaction changes, install the Playwright browser binaries if needed, then run the relevant suites:

```bash
bunx playwright install --with-deps chromium webkit firefox
bun run test:e2e
bun run test:e2e:webkit
bun run test:e2e:firefox
bun run test:a11y
```

Browser tests create isolated D1/R2 state in the operating system's temporary directory and use fake providers and signed test webhooks. Run check, typegen, build, dry-run and browser suites sequentially because they share generated output. Use separate worktrees and test state directories for concurrent verification. Linux WebKit results cover simulated viewports, rather than physical iOS/iPadOS Safari devices. Missing browser binaries are a test environment failure.

`bun run deploy:dry-run` builds a temporary configuration from the public development config without reading the private production config or publishing a Worker. Local checks do not establish production deployment, remote migration, or real mail/Telegram delivery.

Release preflight disables Wrangler's `.env` loading for its child commands so private deployment secret names do not alter the checked-in binding types. It retains the type generation check against the public Worker configuration.

Publish the verified commit to remote Preview only when deployment is requested
or already authorized, following [PREVIEW.md](./PREVIEW.md). Record the SHA, URL,
deployment/version ID and relevant checks; confirm production traffic still
points to its previous deployment. Shared Preview data is read-only for ordinary
acceptance checks; writes and real provider tests require authorization covering
their production effects. Production publication follows the
[production checklist](./PRODUCTION_CHECKLIST.md), with Preview evidence or a
documented alternative when Preview cannot cover the changed handler.

## GitHub release security checks

Ordinary pushes and pull requests do not trigger GitHub Actions. The
`Release security` workflow runs only when a GitHub Release is published
(including a prerelease), or when manually dispatched. Creating a draft
Release or pushing a tag alone does not trigger it.

The workflow checks out the event's immutable SHA, reads the Bun version from
`package.json`, and runs `bun run audit:dependencies` directly against
`bun.lock`, without installing project dependencies. High and critical findings
fail the check. Tests, browser QA, builds, Preview and production deployments
are local operator steps, following the gates above and the production checklist.

To run the scan before publishing a Release:

```bash
gh workflow run release-security.yml --ref main
gh run list --workflow release-security.yml --limit 5
gh run view <RUN_ID> --json headSha,status,conclusion
```

Match the run's `headSha` to the intended release commit and wait for its final
result. A published-Release scan runs after publication; it does not replace
the local dependency audit required before a production deployment.

## Repository map

| Path | Responsibility |
| --- | --- |
| `worker/index.ts` | Worker entry point: web/API `fetch`, inbound `email`, and scheduled tasks |
| `src/routes/` | SvelteKit pages, thin API routes, and the standalone message reader |
| `src/lib/domain/mail/` | Mail contracts, threading, compose, delivery state, and validation |
| `src/lib/server/` | Authentication, D1/R2, inbound/outbound mail, and workspace operations |
| `src/lib/components/` | Shared UI, shell, and mail components |
| `src/lib/i18n/` | English/Simplified Chinese catalogs and locale handling |
| `migrations/` | Ordered D1 migrations; apply these to initialize or upgrade a database |
| `schema.sql` | Latest schema snapshot |

`build/`, `.svelte-kit/`, and `.wrangler/` are generated output. The repository supports tests from a clean checkout without requiring an earlier build.

Wrangler-generated `worker-configuration.d.ts` is the binding type authority. When changing the runtime version, keep `wrangler.toml`, `wrangler.build.toml`, and `wrangler.deploy.toml.example` aligned and regenerate types with `bun run cf:typegen`.

For API contracts, design rules, and operational procedures, use the [documentation index](./README.md).

## Diagnose mailbox navigation

Reproduce with isolated local mail fixtures first. In browser Network, compare a
cold view, returning to the same view within 30 seconds, and an explicit refresh.
A fresh cached return should make no mailbox list request; a stale return keeps
rows visible while refreshing. Authenticated mailbox page, metrics and flags
responses expose `Server-Timing`; list responses include available `auth`,
`metrics`, `list`, `labels` and `total` durations. Phases can overlap, so do not
sum them as wall time. `total` is server processing time, separate from network
latency and browser rendering. Timing logs record operation, request ID, status
and durations, without message identifiers or content.

Use `GET /api/workspace/mailbox/metrics?identity=address:<owned-id>` to check the
navigation badge against `unreadCount`, independent of category/search. GETs
must not write read state. Reopening a reader should issue a flags PATCH only
for unread received mail. See the [spec](./specs/mailbox-navigation-and-read-state.md)
for concurrency, cache invalidation and acceptance cases. Production latency,
real mail and remote schema readiness require separate authorized verification.
