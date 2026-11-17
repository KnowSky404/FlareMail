# Production AI release preparation — 2026-11-17

The user authorized production deployment of the AI summary/classification work merged in PR #28 (`87637410f7c55a9924a27eee3adb40462007eda0`). This record covers the necessary release fixes and the schema-31 → 32 cutover. It does not authorize mail fixtures, real outbound tests, routing changes, resource deletion, credential rotation or database restore.

## Release blockers and minimal fixes

- The production dependency audit reports two high-severity SvelteKit 3.1.0 advisories, both patched in 3.1.1: [server-only import guard](https://github.com/advisories/GHSA-m9j8-jcmv-hp69) and [remote-function form parsing](https://github.com/advisories/GHSA-3r8g-jcqq-3p5j). Upgrade this package and its lockfile without a broad dependency refresh.
- Regenerate `worker-configuration.d.ts` with the installed global cf. Its runtime types drifted from workerd 20261110 to 20261113; do not hand-edit generated declarations.
- Initialize the isolated local D1 before release preflight. Never run browser fixtures against production or copy production data into test logs.
- Browser regression cleanup waits for active mock routes before closing the page; otherwise a successful mobile flow can fail during teardown with a disposed response.
- The accepted AI implementation is unchanged. Repeat local gates, PRE page/API acceptance, local review and current-head Code/Security Review before merging the release fix and publishing production.

## Reviewed cutover plan

Record the final main SHA, accepted PRE SHA/URL, review receipts, production version/deployment IDs, UTC timestamps and results in private operational evidence. Keep resource IDs, addresses, session tokens, bookmarks and provider settings outside Git with mode 0600.

1. Compare production live variables, secret names and D1/R2 bindings with the private target. Preserve existing provider settings, Telegram enablement, schedules and routes. Set APP_VERSION to the final main SHA in a temporary private release target.
2. Save a fresh production D1 Time Travel bookmark and the exact pending migration list. Only `0032_ai_automatic_classification.sql` is expected. Rehearse the classification guards, migration and cleanup on an isolated schema-31 database; verify legacy mappings, incoming inserts and new-column writes.
3. Complete production-mode packaging/dry-run and upload the final verified version without switching traffic. Inspect uploaded bindings and secret presence. Do not bypass local/PRE/review gates; this staged upload shortens the database/code cutover window. There are no intended trigger or route changes.
4. Temporarily pause writes to the two **legacy** classification columns using the following release-only guards. Reads, inbound inserts, flags and new-column writes remain permitted. Existing category edits during the pause fail rather than being silently lost. These guards are operational maintenance, not permanent schema objects, and must be removed after verification.

```sql
CREATE TRIGGER flaremail_release32_email_category_guard
BEFORE UPDATE OF inbox_category ON email_messages
BEGIN SELECT RAISE(ABORT, 'CATEGORY_UPGRADE_IN_PROGRESS'); END;
CREATE TRIGGER flaremail_release32_workspace_category_guard
BEFORE UPDATE OF inbox_category ON workspace_messages
BEGIN SELECT RAISE(ABORT, 'CATEGORY_UPGRADE_IN_PROGRESS'); END;
```

5. Recheck migration target and apply only 0032. Verify schema 32, retained legacy values/manual mappings, new fields and an empty classification queue. Do not enable automatic classification as a deployment side effect. Old schema-31 HTTP code rejects schema 32, so a brief HTTP readiness gap is expected until promotion; the additive migration retains the legacy columns used by inbound persistence.
6. Immediately route 100% to the pre-uploaded, verified production version. Recheck actual deployment, variables, secret names, bindings and schedules. If promotion fails, keep the data/guards intact and retry the verified promotion; do not restore D1 or direct traffic to an incompatible schema-31 version.
7. Verify public liveness, authenticated readiness/version, settings, six-category/legacy-filter APIs and relevant pages. Use ordinary authenticated reads; no production mail fixtures or additional AI generation are needed. Preserve existing settings and credentials. Local fake-handler evidence covers Email Routing/Cron/Telegram; HTTP checks do not prove actual delivery.
8. After the new deployment and business checks are stable, remove only these two task-owned guards and verify no release guard remains:

```sql
DROP TRIGGER IF EXISTS flaremail_release32_email_category_guard;
DROP TRIGGER IF EXISTS flaremail_release32_workspace_category_guard;
```

Verify final schema, migrations, data preservation, main SHA and production traffic; retain PRE and private release evidence. Remove temporary release-only authentication sessions if used.

## Rollback boundary

Migration 0032 is additive, but the previous schema-31 Worker is **not** a compatible code rollback: it rejects schema 32 and cannot interpret new category choices. Rehearsal must confirm this boundary. Recovery preserves D1/R2 and uses a schema-32-compatible accepted build or a forward fix; no automatic database restore, column removal or mail deletion is allowed. Keep the pre-change version/bookmark for separately reviewed incident recovery. Do not describe switching to the old version as a safe one-click rollback.

## Evidence status

Initial production inventory: schema 31; only 0032 pending; live private-target variables, bindings and secret declarations match. The original implementation's 950 tests pass. Initial preflight failed on the two dependency advisories, stale generated types and uninitialized/local-environment checks; these failures are not release clearance. Production data and traffic remain unchanged at this preparation stage.

Final commands, SHAs, checks, PRE acceptance and review receipts belong in the release-fix PR and private `/tmp/flaremail-production-evidence/` records. Remote production success must be recorded only after the steps above actually complete.

Local release-fix validation: SvelteKit is pinned to 3.1.1; only that package changes in the lockfile. The audit has no high-severity findings. Frozen install, 950 tests, check, generated-type consistency and build/dry-run passed. Chromium desktop/mobile/320px, WebKit desktop and Firefox desktop each passed four targeted browser cases (20 total), including settings/secret blankness, reader confirmation boundaries, summary, axe and overflow. Firefox uses the same container-only content-sandbox workaround as the original PRE work. The first mobile run exposed a mock-route teardown race; awaiting active routes fixed it and the complete matrix passed.

The isolated schema-31 rehearsal passed: legacy category updates are blocked during the guard window, manual values map correctly through 0032, inbound inserts/new-column updates work, the two guards can be removed, and the previous Worker rejects schema 32 as documented. No production data was used in this rehearsal. Default-sandbox preflight cf probes fail on the read-only global dev-registry directory; full preflight requires local permission to use that cache, without enabling remote operations.
