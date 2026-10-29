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

The checked-in `cloudflare.local.json` uses local D1/R2, `AUTH_MODE=local`, and the demo outbound provider with `ALLOW_FAKE_SERVICES=true`. Local bindings and variables live in `cloudflare.local.json`; use an ignored private target with `FLAREMAIL_CF_CONFIG` for local secret overrides. Native cf does not infer bindings from the former `.dev.vars` file. Keep real credentials out of Git.

The workflow is a dedicated worktree and branch, local implementation and
verification, a committed change, and authorized remote PRE (Preview) acceptance
for feature changes. Run local `/review` and resolve findings before each task
push and again before creating a PR targeting `main`, including for
documentation-only changes. Wait for Codex bot review of the current head and
address its findings, then rebase merge, verify and sync main, and clean up the
merged task worktree and branches. These Git steps have standing authorization
for requested changes unless the user limits the task. Preview and production
publication each require separate authorization. Ordinary development does not
automatically deploy.
The repository's configured preview environments share production D1/R2 and
the Owner account; writes there affect production. Use local state for
development and read the [preview guide](./PREVIEW.md) before using a remote
preview. Production uses Resend and rejects missing required bindings or secrets.

## Worktree and PR workflow

All feature iterations, bug fixes, refactors, tests, configuration and
documentation/instruction changes follow the same workflow, including small fixes:

**Dedicated local worktree + task branch → local implementation and verification
→ atomic commit → local `/review` and resolved findings before each push and PR
creation → push and PR → completed Codex bot review of the current head and
resolved findings → rebase merge into `main` → verify and sync main → remove the
merged local/remote task branches and worktree.**

For changes the user requests, task-branch push, PR creation, rebase merge after
review, and merged task cleanup have standing authorization once their gates
pass. Continue without asking for separate confirmation at each Git step, unless
the user requests local-only work, withholds a step, or asks to retain a branch or
worktree. This authorization excludes direct pushes to `main`, Preview or
production deployment, remote migrations and production data writes; those still
need their own authorization. Follow the local review and PRE gates below.
Documentation-only changes do not require PRE but still require local `/review`.
Preserve unmerged work and unsaved files.

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
3. After PRE acceptance, complete local `/review` and resolve findings before
   pushing the task branch; run it again before creating a PR targeting `main`.
   Include the base SHA, accepted SHA, local review and verification evidence,
   PRE evidence, and uncovered behavior. Documentation-only changes use diff,
   command and link checks plus local `/review`, and mark PRE as not applicable.
4. Changes to the implementation after acceptance require affected local gates
   and PRE acceptance again before merge. If PRE is blocked, retain the branch
   and report the blocker; bypassing the gate requires explicit authorization.
   Record alternative verification for handlers PRE cannot exercise.
5. Once local and bot review gates pass and valid findings are resolved, rebase
   merge into `main` and complete cleanup under the standing Git authorization,
   unless the user restricts the task. Direct pushes to `main` and production
   deployment still need separate explicit authorization; an authorized direct
   push still follows local `/review`, verification and PRE gates. Before
   production, check the final SHA and contents
   against PRE evidence, repeat verification and acceptance if contents changed,
   and follow the exact-commit gates in the
   [production checklist](./PRODUCTION_CHECKLIST.md).

### Local review before push and PR

Before every push of task commits and separately before every PR creation,
actually run Codex's built-in `/review` in the task worktree. This includes the
initial push, follow-up commits, fixes to bot findings, base synchronization and
documentation/instruction changes. Reading a diff, a verbal self-check, passing
tests or a later bot review does not satisfy this gate. Conditional deletion of
an already merged remote branch follows the cleanup procedure below.

Review the complete task diff against the target `origin/main`, rather than
only the last commit or an empty uncommitted diff. In interactive Codex, use
`/review` and choose the base-branch review. The non-interactive equivalent is:

```bash
codex review --base origin/main
```

Check the installed `codex review --help` when needed. See the
[official local review guide](https://learn.chatgpt.com/docs/code-review#review-local-changes).
Assess every finding, fix all confirmed issues and record evidence for false
positives or inapplicable findings. After fixes, run affected local gates, create
atomic commits, complete required PRE acceptance, then run `/review` again until
no valid issue remains unresolved. Resolve issues before pushing or opening a PR.

Record the command/scope, time, base SHA, reviewed head SHA, result and finding
disposition. Before push or PR creation, verify that the final head, diff and
base still match the review evidence. Any later edit, commit, rebase or conflict
resolution requires affected verification and a new `/review`; do not reuse
stale results. Include the evidence in the PR and update it for follow-up commits.

If local `/review` is unavailable, fails, remains incomplete or lacks verifiable
passing evidence, retain the local branch/worktree and report the blocker;
do not push task commits or create a PR. Retain any existing PR without merging.
Local review and the PR bot's Code Review and Security Review are independent
gates and all must pass.

### Rebase merge and cleanup

After opening a PR or pushing a new commit, actively check whether Codex bot
review has started. If triggered, wait for review of the current head to finish
and address findings before merging. A review that has not appeared yet does
not establish that review is disabled; follow the configured review gates below.

Every PR must complete Codex bot review before merge, including documentation
and instruction changes. The current bot is `chatgpt-codex-connector[bot]`;
some `gh` output omits the `[bot]` suffix. Verify the actual author and reviewed
commit. The repository currently runs both Code Review and Security Review;
wait for both to complete for the current PR head. Inspect each status/commit
in the bot's `Codex Review Summary`, submitted reviews and inline findings.
A single summary metadata `status` or `headSha` does not establish completion
of both review types. This GitHub App review is separate from GitHub Actions.
An empty checks list, `CLEAN` mergeability, a review of an older commit, 👀,
an isolated 👍, or `COMMENTED` alone is insufficient evidence for this gate.

Assess each finding, fix confirmed issues and run affected verification, or
record evidence explaining a false positive or inapplicable finding. Do not
merge with an unresolved valid finding. Before pushing a fix, complete local
`/review` again. Any new commit requires completed bot review for the new head,
plus affected local/PRE gates. If review
is pending, failed or lacks current-head evidence, retain the PR, branch and
worktree and report the status; elapsed time does not waive review. Do not
enable auto-merge before this gate has passed. Record completion times, review
SHA and result links with the PR's acceptance evidence. See the
[official Codex review guide](https://learn.chatgpt.com/docs/third-party/github).

After all gates pass, proceed with rebase merge under the standing authorization
unless the user withholds merge or specifies another strategy.
Inspect the PR's base branch, head SHA, commits/files, mergeability and required
checks, and confirm the bot review gate above has passed. Lock the merge to the
verified and reviewed head using
`gh pr merge <PR> --rebase --match-head-commit <HEAD_SHA>`. Do not bypass checks
with `--admin`. Auto-merge or a merge queue request is not a completed merge;
wait until the PR state is `MERGED` before cleanup.

Record the PR URL, original head SHA and resulting merge SHA. Fetch `origin/main`
and verify it contains the merge SHA. Rebase rewrites commit identities: compare
the original and merged patches/contents, using `git range-diff` where useful,
instead of relying only on ancestry of the original SHA. If main has advanced
with unrelated changes, compare the PR's original and rebased commit ranges,
rather than requiring the whole task tree to equal the latest main tree.
Changed implementation contents require updated verification and PRE acceptance.

From the preserved main checkout, sync with `git merge --ff-only origin/main`
only when it is on `main`, clean and can fast-forward. Preserve a dirty or
diverged checkout and report the limitation; do not reset, stash or rebase user
work. Task cleanup can proceed independently if its merge is proven and its
worktree and branches meet the cleanup conditions.

After a verified authorized merge, clean up that task by default unless the user
requests retention:

1. Confirm any remaining local and remote task branches point to the merged PR
   head, with no later commits. Inspect staged/unstaged and untracked files,
   as well as ignored files that need retention. Preserve acceptance evidence
   and private configuration outside the disposable worktree, and stop its
   temporary services. Never remove another task's worktree or the main checkout.
2. From a retained checkout, remove the clean task checkout with
   `git worktree remove <PATH>`. Do not use `--force`. Then delete its local
   branch with `git branch -d <BRANCH>` if it still exists. Delete the remote
   branch only with an explicit lease pinned to the verified merged PR head:
   `git push --force-with-lease=refs/heads/<BRANCH>:<VERIFIED_HEAD_SHA> origin :refs/heads/<BRANCH>`.
   This conditional deletion does not authorize overwriting branch history.
   Never use unconditional `--delete` or `--force`. If the remote branch is
   already absent, record that result. If the lease fails, preserve the remote
   branch and report it; do not replace the expected SHA with a new unmerged
   head and retry deletion. Keep worktree removal separate from PR merge so
   each result can be checked.
3. If `-d` refuses only because rebase changed ancestry, `-D` is permitted for
   this task branch only after checking the PR's `MERGED` record, merge SHA
   in main, unchanged task head and equivalent patches. A successful `-d`
   alone does not prove integration into main; it can check the branch upstream.
   Unmerged commits, unsaved files, another worktree using the branch, or a
   retention request stop the affected cleanup and must be reported.
4. Verify PR state, local/remote main SHAs, working tree status, and absence of
   the task worktree and branches. Report the PR URL, final SHA, verification,
   cleanup result and remaining blockers. Merge and cleanup do not deploy
   production.

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

Release preflight disables cf's `.env` loading for its child commands so private deployment secret names do not alter the checked-in binding types. It retains the type generation check against the public Worker configuration.

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

`build/`, `.svelte-kit/`, and `.cloudflare/` are generated output. The repository supports tests from a clean checkout without requiring an earlier build.

cf generates `worker-configuration.d.ts` through `bun run cf:typegen`. Keep the compatibility date/flags in all JSON targets aligned. The script normalizes generated import paths for the checked-in location; do not edit the generated types manually. The official Svelte adapter still uses a generated, ignored compatibility config internally; project commands and native Worker Build Output use global cf.

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

## Global cf and Worker packaging

Install Node.js >= 22.18 and `bun add --global cf`. Verify `command -v cf` and `cf --version`; no local cf executable should shadow the global installation. `cf` is executed by Node, even when Bun launches a project script.

`bun run build:app` builds SvelteKit 3. `bun run build` also invokes global `cf build` in the `worker` workspace, using the Cloudflare Vite plugin. `worker/index.ts` retains fetch/email/scheduled. Only filtered client assets are copied to `.cloudflare/assets`; `_worker.js` and source maps are excluded. The native Build Output is in `worker/.cloudflare/output`.

Use `bun run preview` for the complete local Worker. Set `FLAREMAIL_DEV_HOST` (default `::`) and `FLAREMAIL_DEV_PORT` (default `8787`); cf does not forward arbitrary Vite host/port arguments. Local D1/R2 and the runtime share `.cloudflare/state`; override `FLAREMAIL_STATE_DIR` per worktree/test. The previous `.wrangler` state is not implicitly reused or migrated. For user access, verify IPv4/IPv6 using `ss -lntp` and provide `http://oc-de-fra-1.knowsky.uk:<port>`.

`bun run dev` remains the Svelte HMR server; its adapter proxy mirrors the public local target and shares the same isolated state directory. Use `bun run preview` for acceptance of the complete fetch/email/scheduled wrapper. SvelteKit 3 keeps the existing `$lib` imports through its documented compatibility alias. TypeScript 6 is intentional: TypeScript 7 no longer provides the compiler API used by SvelteKit.
