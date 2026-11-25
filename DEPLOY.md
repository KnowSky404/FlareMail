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

The verified local build uses cf `1.0.0-rc.1` with the Vite plugin locked at `2.0.0-rc.0`. Use the same compatible cf version for builds, type generation and release preflight. The SvelteKit Cloudflare adapter receives a generated, ignored compatibility config during the Svelte build.

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

Follow the Preview guide before opening a functional PR. The current native PRE uses dedicated D1, R2 and Owner mapping. Default acceptance is read-only. Real mail, Telegram, data writes, remote migrations and routing/DNS changes require their own authorization. See [Preview guide](docs/PREVIEW.md).

```sh
# Authorized PRE only; uses private cloudflare.preview.json
bun run deploy:pre -- --preview-name mail-ai
```

Run local `/review` before each push and separately before PR creation. Wait for the current head's Codex Code Review and Security Review; resolve feedback before rebase merge. Record the accepted commit, Preview URL/ID and business acceptance. See [repository workflow](AGENTS.md) and [production checklist](docs/PRODUCTION_CHECKLIST.md).

About displays the highest stable `vMAJOR.MINOR.PATCH` Git tag reachable from the build commit. Before building for deployment, run `git fetch --tags`, or `git fetch --unshallow --tags` from a shallow checkout. Release preflight and deployment reject shallow checkouts. For a new release, create its tag locally on the verified commit before the production build, then publish the matching GitHub Release after deployment checks. A source checkout without release tags uses the version in `package.json`. Authenticated `/api/readiness` continues to report the configured `APP_VERSION` build label.

Production is a separate, explicitly authorized step from a clean verified `origin/main` commit:

```sh
bun run deploy
```

This builds the application and runs global `cf deploy --mode production` in `worker/`. Production provisioning is disabled (`--provision=false`): a mistyped/missing binding fails instead of creating replacement resources. Secret-file paths are resolved from the caller directory before entering `worker/`. It is not a PRE command. Do not apply triggers or deploy an uploaded version separately to bypass the release gates. List required existing Worker secret names in the target `secrets` array; values never belong in JSON targets. Keep secret files outside the repo with mode `0600`; when needed, pass the reviewed `--secrets-file <path>` through `bun run deploy -- ...`. Check the installed CLI's help and inspect secret **names only**, never values. Migrate all existing Dashboard non-secret variables into the private target before deploying: native cf replaces variables with `target.vars`, and Dashboard-only edits are not preserved. Review required existing secret names separately; do not assume a code upload configures a new account.

## Data, Owner and provider setup

Migrations remain append-only in `migrations/`; `schema.sql` is a snapshot. Local: `bun run db:migrate:local`. Remote: inspect the exact D1 UUID, pending list, recovery bookmark and current production-code compatibility first, then run `bun run db:migrate:remote` only with explicit authorization. Both scripts accept `-- --dry-run`, forwarding it to cf without applying migrations; unknown options fail before invoking cf. Never run fixtures or automated browser seeds against shared PRE/production data.

Schema 36 requires a coordinated migration and Worker cutover if any running
Worker using the database requires an earlier schema. See the [delivery attention upgrade checklist](docs/PRODUCTION_CHECKLIST.md#schema-38-delivery-attention-upgrade) for PRE isolation and rollback requirements.

Discover resource commands using anonymous queries such as `cf cli search "list database migrations"`; inspect help/schema and a dry-run before a new operation. cf's local SQL command is `cf d1 raw <database-id> --local --persist-to <isolated-state> --sql <sql>`; `cf d1 query` is not the local equivalent. Raw result column/value arrays are normalized by the maintenance scripts without discarding statement metadata.

Initialize the stable Owner once with the existing `auth:bootstrap:*` project scripts, only against the intended authorized target. Login credentials, profile email and managed mail identities remain separate. Do not bootstrap or reset an existing PRE/production Owner as part of validation.

Configure Email Routing for managed receiving addresses and a Resend-verified sending domain. Workspace messages use the selected managed sender. Keep the stable production Worker/account as the Email Routing destination and follow the management UI procedure for environments with a dedicated route target. Current PRE identity acceptance uses saved records. Enable inbound routing after verifying Owner, storage, authentication and outbound-provider setup. See [Preview identity acceptance](docs/PREVIEW.md).

After deployment, `/api/health` proves liveness. Authenticated `/api/readiness` checks bindings/schema. Verify login, mailbox, owned HTML/CID attachments and authorization errors. HTTP checks do not prove `email()`, scheduled handling or real provider delivery; record separate authorized evidence. Rollback must consider code and data compatibility together; never restore D1 without a reviewed recovery target and separate authorization.

With single-Worker PRE inbound configured, verify the running production email handler as part of PRE storage changes. Select rollback code that keeps the reserved-address guard and pauses PRE delivery. See [Preview guide](docs/PREVIEW.md), [production checklist](docs/PRODUCTION_CHECKLIST.md) and [single-Worker PRE inbound SPEC](docs/specs/single-worker-pre-inbound.md).

## 中文操作说明

统一使用全局 `cf`，不再直接调用 Wrangler。先安装 Node.js ≥ 22.18 和 `bun add --global cf`，用 `cf auth login` 登录。依赖、构建和测试仍通过 Bun 项目脚本执行。

`bun run build` 会先构建 SvelteKit，再由全局 `cf` 原生打包 Worker。`bun run preview` 用于本地预览，`bun run deploy:pre -- --preview-name mail-ai` 用于授权后的远程 PRE，`bun run deploy` 用于另行授权的生产发布。私有配置分别为 `cloudflare.preview.json` 和 `cloudflare.deploy.json`，由对应公开示例填写，禁止提交真实资源标识或密钥。

当前原生 PRE 使用独立 D1、R2 和 Owner 映射，默认只读验收。本地测试使用独立 `.cloudflare/state`。普通功能改动先完成对应提交的本地检查、PRE 业务验收、本地 `/review` 和当前 head 的两项机器人审查，再合并主分支。生产发布另行授权。参见 [Preview 指南](docs/PREVIEW.md)。

「关于」显示构建提交历史中版本号最高的稳定 `v主版本.次版本.补丁版本` 标签。部署构建前执行 `git fetch --tags`，浅克隆应执行 `git fetch --unshallow --tags`，发版预检和部署脚本都会拒绝浅克隆。发新版本时，在核对过的提交上先创建本地标签，再构建和部署生产，验收后发布对应的 GitHub Release。PRE 验收后如果补打标签导致版本显示改变，上传前用新构建复核「关于」显示。拿不到发布标签时使用 `package.json` 中的版本。登录后访问 `/api/readiness` 仍能看到 `APP_VERSION` 构建标识。

单 Worker 收信方案启用后，调整 PRE 存储须同时核对生产收信代码。生产回退使用保留地址拒收保护、且暂停 PRE 投递的版本。参见 [生产发布清单](docs/PRODUCTION_CHECKLIST.md)和[单 Worker SPEC](docs/specs/single-worker-pre-inbound.md)。

本地与远程迁移脚本均支持 `-- --dry-run`，会透传给 cf，仅预检而不应用迁移；未知选项直接报错，避免拼错参数后意外执行写入。

The [archived Wrangler guide](docs/archive/wrangler-deployment.md) preserves the former workflow for historical reference only. Current command authority is this guide and the [official cf documentation](https://developers.cloudflare.com/cf/).
