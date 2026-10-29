# FlareMail deployment with global cf

Cloudflare operations use the **globally installed cf CLI**, running under Node.js ≥ 22.18. The project no longer invokes Wrangler directly. Bun runs the application and project scripts; do not run cf with `bun --bun`.

```sh
bun add --global cf
command -v cf
cf --version
cf auth login
# SSH: cf auth login --no-browser
bun install --frozen-lockfile
```

The verified migration baseline is cf `1.0.0-beta.25`. cf and its native Vite integration are beta; check command help before changing the global version. Project libraries remain locked in `bun.lock`. The official SvelteKit Cloudflare adapter still has an upstream Wrangler peer dependency and receives a generated, ignored compatibility config during the Svelte build. It is not the project's CLI or deployment configuration.

## Build and local validation

```sh
bun run test
bun run check
bun run build
bun run cf:typegen -- --check
bun run deploy:dry-run
bun run audit:dependencies
```

The build has two stages: SvelteKit 3 creates the application, then global `cf build` packages `worker/index.ts` through the native Cloudflare Vite plugin in the `worker` workspace. The wrapper exports **fetch, email and scheduled**. Filtered browser assets exclude server `_worker.js` and source maps. Native Build Output lives under `worker/.cloudflare/output`; never deploy the Svelte directory as unfiltered public assets.

`deploy:dry-run` builds the public local target and runs `cf deploy --prebuilt --dry-run`; it does not read a private target, authenticate, upload or migrate remote D1. `bun run release:preflight -- --json` also requires a clean committed worktree and runs the local release gates.

Local D1/R2 and `bun run preview` share `.cloudflare/state`. Override `FLAREMAIL_STATE_DIR` for isolated tests. The old `.wrangler` state is not implicitly reused. `bun run dev` is the Svelte HMR server with the selected local target and shared isolated persistence; use `bun run preview` to exercise the complete Worker. Host/port are configured with `FLAREMAIL_DEV_HOST` and `FLAREMAIL_DEV_PORT` (default `::`, `8787`).

## Configuration and migration

`cloudflare.config.ts` is the native configuration. It selects a JSON target:

| Mode | Target | Allowed environment |
| --- | --- | --- |
| development | `cloudflare.local.json` (public, demo provider) | development/test |
| production | `cloudflare.deploy.json` (private) | production |
| preview | `cloudflare.preview.json` (private) | preview |

Copy the corresponding `.example`, fill in the actual D1 UUID, database name, bucket, authentication/provider variables and Worker name, then protect the file with `chmod 600`. Private targets are ignored by Git. `FLAREMAIL_CF_CONFIG` can select another explicit target. Remote commands fail closed for local targets or placeholder bindings; no command should provision replacement production resources to work around missing config.

Retired TOML configurations are not loaded. Migrate their non-secret variables, binding IDs/names, compatibility settings, schedules and observability settings into the appropriate JSON target. JSON uses `compatibilityDate`, `compatibilityFlags`, `databaseId`, `databaseName`, `bucket`, `cron` and `vars`. Observability uses camelCase, including `headSamplingRate`. Keep all templates aligned. `.dev.vars` is not an implicit source of deployment secrets.

Keep production `APP_ENV=production`, the real provider (normally `resend`), the reviewed Owner authentication mode and real `APP_BASE_URL`. Never enable demo/fake providers in production. Disable URL tracing when Telegram tokens may appear in provider URLs. The public templates disable Telegram until its privacy/configuration boundary is reviewed.

## PRE, PR and production

Follow the [Preview guide](docs/PREVIEW.md) before opening a functional PR. PRE code does not switch production traffic, but its D1/R2 and Owner are shared: default acceptance is read-only. Real mail, Telegram, data writes, remote migrations and routing/DNS changes require their own authorization.

```sh
# Authorized PRE only; uses private cloudflare.preview.json
bun run deploy:pre -- <preview-name>
```

Run local `/review` before each push and separately before PR creation. Wait for the current head's Codex Code Review and Security Review; resolve feedback before rebase merge. Record the accepted commit, Preview URL/ID and business acceptance. See [repository workflow](AGENTS.md) and [production checklist](docs/PRODUCTION_CHECKLIST.md).

Production is a separate, explicitly authorized step from a clean verified `origin/main` commit:

```sh
bun run deploy
```

This builds the application and runs global `cf deploy --mode production` in `worker/`. Production provisioning is disabled (`--provision=false`): a mistyped/missing binding fails instead of creating replacement resources. Secret-file paths are resolved from the caller directory before entering `worker/`. It is not a PRE command. Do not apply triggers or deploy an uploaded version separately to bypass the release gates. List required existing Worker secret names in the target `secrets` array; values never belong in JSON targets. Keep secret files outside the repo with mode `0600`; when needed, pass the reviewed `--secrets-file <path>` through `bun run deploy -- ...`. Check the installed CLI's help and inspect secret **names only**, never values. Migrate all existing Dashboard non-secret variables into the private target before deploying: native cf replaces variables with `target.vars`, and Dashboard-only edits are not preserved. Review required existing secret names separately; do not assume a code upload configures a new account.

## Data, Owner and provider setup

Migrations remain append-only in `migrations/`; `schema.sql` is a snapshot. Local: `bun run db:migrate:local`. Remote: inspect the exact D1 UUID, pending list, recovery bookmark and current production-code compatibility first, then run `bun run db:migrate:remote` only with explicit authorization. Never run fixtures or automated browser seeds against shared PRE/production data.

Discover resource commands using anonymous queries such as `cf cli search "list database migrations"`; inspect help/schema and a dry-run before a new operation. cf's local SQL command is `cf d1 raw <database-id> --local --persist-to <isolated-state> --sql <sql>`; `cf d1 query` is not the local equivalent. Raw result column/value arrays are normalized by the maintenance scripts without discarding statement metadata.

Initialize the stable Owner once with the existing `auth:bootstrap:*` project scripts, only against the intended authorized target. Login credentials, profile email and managed mail identities remain separate. Do not bootstrap or reset an existing PRE/production Owner as part of validation.

Configure Email Routing for managed receiving addresses and a Resend-verified sending domain; workspace messages use the selected managed sender. Keep the stable production Worker/account as the Email Routing destination during PRE. Enroll domains/addresses through the existing management UI. Do not point Email Routing at a Preview. Enable inbound routing only after Owner, storage, authentication and outbound-provider setup are verified.

After deployment, `/api/health` proves liveness. Authenticated `/api/readiness` checks bindings/schema. Verify login, mailbox, owned HTML/CID attachments and authorization errors. HTTP checks do not prove `email()`, scheduled handling or real provider delivery; record separate authorized evidence. Rollback must consider code and data compatibility together; never restore D1 without a reviewed recovery target and separate authorization.

## 中文操作说明

统一使用全局 `cf`，不再直接调用 Wrangler。先安装 Node.js ≥ 22.18 和 `bun add --global cf`，用 `cf auth login` 登录。依赖、构建和测试仍通过 Bun 项目脚本执行。

`bun run build` 会先构建 SvelteKit，再由全局 `cf` 原生打包 Worker；`bun run preview` 是本地预览，`bun run deploy:pre -- <名称>` 是授权后的远程 PRE，`bun run deploy` 是需单独授权的生产发布。私有配置分别为 `cloudflare.preview.json` 和 `cloudflare.deploy.json`，由对应公开示例填写，禁止提交真实资源标识或密钥。

PRE 共用生产数据和 Owner，默认只读验收。本地测试使用独立 `.cloudflare/state`，不会自动读取旧 `.wrangler` 状态。普通功能改动必须完成对应提交的本地检查、PRE 业务验收、本地 `/review` 及当前 head 的两项机器人审查，再合并主分支；合并不等于生产发布。

The [archived Wrangler guide](docs/archive/wrangler-deployment.md) preserves the former workflow for historical reference only. Current command authority is this guide and the [official cf documentation](https://developers.cloudflare.com/cf/).
