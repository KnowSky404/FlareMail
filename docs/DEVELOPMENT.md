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
baseline, which CI reads directly. Release preflight checks
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

The current `mail-ai` Preview uses dedicated D1 and R2. Preserve deployed
bindings and use local state for development. Production uses Resend and
rejects missing required bindings or secrets. See [Preview guide](./PREVIEW.md).

## Worktree and PR workflow

Use the [risk-based workflow](./WORKFLOW.md) for all changes. Record scope,
risk and acceptance criteria before starting. Follow its CI, review and PRE
requirements and the authorization boundaries in [AGENTS.md](../AGENTS.md).

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

Record task state in each worktree's ignored `.task/` directory. The
[workflow](./WORKFLOW.md#任务记录与度量) defines the minimum fields and update points.
An implementation task that resumes after a pause uses its saved scope and
verifies its current branch, diff and remote PR before changing anything.

For a risk level requiring independent local review, inspect the installed
Codex command. For a full base-branch review, run:

```bash
codex review --base origin/main
```

Record the command, reviewed files or diff, base and head identifiers and
finding decisions. Use affected verification and a focused independent review
for follow-up changes within the risk policy.

### Rebase merge and cleanup

Verify the exact candidate's CI and required reviews under the
[workflow gates](./WORKFLOW.md#review-边界与轮次). Record blocking and deferred
findings, PRE acceptance when required, and any permitted alternative evidence.

After all gates pass, proceed with rebase merge under the standing authorization
unless the user withholds merge or specifies another strategy.
Inspect the PR's base branch, head SHA, commits/files, mergeability and required
checks, and confirm the applicable [workflow gates](./WORKFLOW.md) have passed. Lock the merge to the
verified and reviewed head using
`gh pr merge <PR> --rebase --match-head-commit <HEAD_SHA>`. Verify the base SHA
against the CI result immediately before submitting the command. The head lock
does not lock the base. Keep auto-merge disabled when review or PRE gates
depend on manual verification. On an unprotected branch, run a single checked merge,
then verify its actual integration tree. If another merge advanced the base
during the request, mark the changed result unverified and rerun affected
gates before release. Do not bypass checks with `--admin`. Wait for `MERGED`
before cleanup.

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

POST a complete RFC5322 message as the request body to `/cdn-cgi/local/email?from=...&to=...`. The body must be raw mail, rather than JSON. The envelope `to` must match an enabled managed address or a verified domain collection policy. Login usernames and profile emails do not determine inbound ownership.

The demo/fake provider validates the UI, persistence, and mail state transitions locally. It does not contact Resend or establish real delivery. Production delivery is tracked through signed Resend webhooks; see [deployment](../DEPLOY.md).

## Verify changes

Choose verification before running it. Review diffs, commands and links for
documentation edits. For a small code or test change, start with the affected
test case or file and include relevant callers. Run `bun run check` for
application TypeScript, Svelte and route changes. Verify the relevant build
when packaging, build or Worker configuration changes. For validation
scripts and CI, exercise the affected command or workflow.

```bash
bun test scripts/runtime-fixtures.test.ts -t 'supports a safe default temporary output directory'
```

Cover affected integration paths for permissions, D1 schema or migrations, and
shared behavior. Run the full suite when the impact cannot be bounded or when
required by the production checklist or task. Record the checks run and omitted
scope. After a revision, rerun the checks whose results the change can affect.

For a visible interaction change, select the spec, test and browser project
that cover it. Add the affected viewports or browser engines for responsive,
keyboard, accessibility or compatibility changes. Use a private local temporary
directory for the test state. If the required browser is missing, install
that engine with `bunx playwright install --with-deps chromium` or substitute
`webkit` or `firefox` for the selected project.

```bash
task_tmp=$(mktemp -d /tmp/flaremail-qa.XXXXXXXX)
TMPDIR="$task_tmp" TMP="$task_tmp" TEMP="$task_tmp" \
  FLAREMAIL_E2E_STATE_DIR="$task_tmp/flaremail-e2e/desktop/state" \
  FLAREMAIL_E2E_PROJECT=desktop bunx playwright test tests/e2e/list-settings.spec.ts --project=desktop
```

Use `-g '<test title>'` to select one Playwright case. Browser tests seed
isolated D1/R2 with synthetic data and use fake providers and signed test
webhooks. Once the test process exits, retain any needed failure diagnostics
or acceptance evidence and remove its disposable state. Run check, typegen,
build, dry-run and browser runs sequentially within one worktree because
they share generated output. Use separate worktrees, state directories and
ports for concurrent runs. Linux WebKit covers simulated viewports.

`bun run deploy:dry-run` builds a temporary configuration from the public development config without reading the private production config or publishing a Worker. Local checks do not establish production deployment, remote migration, or real mail/Telegram delivery.

Release preflight disables cf's `.env` loading for its child commands so private deployment secret names do not alter the checked-in binding types. It retains the type generation check against the public Worker configuration.

Publish the verified commit to remote Preview only when deployment is requested
or already authorized, following [PREVIEW.md](./PREVIEW.md). Record the SHA, URL,
deployment/version ID and relevant checks; confirm production traffic still
points to its previous deployment. Remote Preview data is read-only for ordinary
acceptance checks; writes and real provider tests require authorization covering
their production effects. Production publication follows the
[production checklist](./PRODUCTION_CHECKLIST.md), with Preview evidence or a
documented alternative when Preview cannot cover the changed handler.

## GitHub checks

See the [CI design](./WORKFLOW.md#ci-和仓库门禁) for fast checks, the extended
browser suites and the stable merge check. An offline build or a local test
does not substitute for required PR CI.

Verify a scheduled, dispatched or published-Release audit against its exact
SHA and final conclusion. The production checklist requires a dependency
audit before deployment.

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

For repeatable Chromium timing and D1 query plans across mailbox sizes, use the
[mailbox performance harness and evidence](./verification/mailbox-performance.md).
The D1 harness replaces the synthetic mailbox in a dedicated E2E Worker.

## Verify message reading modes

Use isolated local HTML/CID fixtures to exercise Plain text, Safe HTML and Unsafe
HTML on desktop, mobile and narrow viewports. Safe HTML must make no remote image
requests, including when the legacy `remote=1` API parameter is supplied. Only
`mode=unsafe` permits HTTPS images; scripts, forms, frames, CSS resource URLs and
HTTP images remain blocked in both HTML modes. Switching messages must reset the
unsafe selection. Inspect the information control with hover, keyboard focus and
touch, and confirm there are no injected safety banners in the body.

Open the header's message-details control and verify sender/recipient information,
labels, attachment summary and technical headers remain accessible without growing
the fixed header or clipping the body. Cover Escape, outside-click dismissal and
focus return, as well as the normal pane, focused reader and standalone message
page. See the [API contract](./API.md#html-safety-boundary) and the
[Preview guide](./PREVIEW.md) for authorized remote acceptance.

## Global cf and Worker packaging

Install Node.js >= 22.18 and `bun add --global cf`. Verify `command -v cf` and `cf --version`; no local cf executable should shadow the global installation. `cf` is executed by Node, even when Bun launches a project script.

`bun run build:app` builds SvelteKit 3. `bun run build` also invokes global `cf build` in the `worker` workspace, using the Cloudflare Vite plugin. `worker/index.ts` retains fetch/email/scheduled. Only filtered client assets are copied to `.cloudflare/assets`; `_worker.js` and source maps are excluded. The native Build Output is in `worker/.cloudflare/output`.

Use `bun run preview` for the complete local Worker. Set `FLAREMAIL_DEV_HOST` (default `::`) and `FLAREMAIL_DEV_PORT` (default `8787`); cf does not forward arbitrary Vite host/port arguments. Local D1/R2 and the runtime share `.cloudflare/state`; override `FLAREMAIL_STATE_DIR` per worktree/test. The previous `.wrangler` state is not implicitly reused or migrated. For user access, verify IPv4/IPv6 using `ss -lntp` and provide `http://oc-de-fra-1.knowsky.uk:<port>`.

`bun run dev` remains the Svelte HMR server; its adapter proxy mirrors the selected local target and shares the same isolated state directory. Use `bun run preview` for acceptance of the complete fetch/email/scheduled wrapper. SvelteKit 3 keeps the existing `$lib` imports through its documented compatibility alias. TypeScript 6 is intentional: TypeScript 7 no longer provides the compiler API used by SvelteKit.

## Optional mail AI

See [AI setup and fake-provider testing](AI.md). AI tests do not need provider credentials. Use isolated local D1/R2; never analyze shared real email as a fixture.

## AI summary and classification

The [SPEC](specs/ai-summary-and-automatic-classification.md) defines six purpose categories, cache-first reading, workspace output language and opt-in new-mail classification. Schema 32 is required. Run AI persistence/dispatcher, category API/query and migration tests with fake providers before browser QA. Cron classification is independent of Telegram; keep model calls outside inbound persistence. Do not use real mail as fixtures or raise the shared quota implicitly.


## Validate delivery attention locally

Run the isolated Playwright `delivery-attention.spec.ts` project on Chromium
desktop, mobile and narrow, and Firefox/WebKit desktop. The fixture writes to
the loopback Local Explorer only after verifying the synthetic workspace Owner.
Screenshots can be retained by setting `FLAREMAIL_ATTENTION_SCREENSHOTS` to the
task's artifact directory. See the [lifecycle spec](specs/delivery-attention-lifecycle.md).
