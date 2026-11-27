# Repository Guidelines

## 默认开发工作流

按 [研发工作流](docs/WORKFLOW.md) 确认需求、范围、验收标准和 R0–R3 风险。每次变更在基于最新 `origin/main` 的独立 worktree 和任务分支完成。本地定向验证和差异自检后创建原子 Conventional Commit，可推送任务分支并提前开 Draft PR。按风险完成 CI、独立审查和业务验收，再以 rebase 合并 `main`。详细命令见 [开发指南](docs/DEVELOPMENT.md)。

项目默认授权覆盖任务分支 push、PR、门禁通过后的 rebase 合并及经核对的任务分支和 worktree 清理。用户明确限制的步骤以其要求为准。直接推送 `main`、PRE/生产部署、远程迁移、远程数据写入和资源操作各自遵循已有明确授权。禁止未经授权改动远端仓库规则或生产流量。保留原工作树、无关改动和未合并分支。

本地以隔离 D1/R2 和 demo 或 mock provider 验证。需要正式 PRE 的任务在当前候选的 CI、必要审查和阻断项处理结束后部署，记录业务证据。生产发布需要独立授权，并执行 [生产清单](docs/PRODUCTION_CHECKLIST.md)。发布台账要区分本地、CI、PRE、PRO、远程迁移和真实供应商验收。

达到 [Review 预算](docs/WORKFLOW.md#review-边界与轮次) 仍有阻断项时，保留分支、PR 和证据，由 Owner 决定拆分或处置。满足 [完成标准](docs/WORKFLOW.md#完成标准) 后停止扩展任务。

## Code Review Rules

审查本次引入或明显放大的行为，优先核对权限、邮件隐私、数据完整性、兼容性和回归。用可复现触发条件和实际影响说明问题。级别、阻断和延期规则见 [Review 指南](docs/WORKFLOW.md#review-边界与轮次)。

## 项目结构与模块组织

`src/` 是 SvelteKit 主应用目录。页面放在 `src/routes/`，接口使用 `+server.ts`，例如 `src/routes/api/messages/+server.ts`。纯邮件契约放在 `src/lib/domain/mail/`；仅服务端可用的认证、D1、入站、出站与工作区逻辑放在 `src/lib/server/`。Worker 包装入口位于 `worker/index.ts`，统一承载网页/API 的 `fetch` 与 Email Routing 的 `email()`。D1 变更以 `migrations/` 为权威顺序，`schema.sql` 只是最新结构快照。`build/`、`.svelte-kit/`、`.cloudflare/` 均为构建产物，不要手改。

## 工具与依赖版本

- Bun 默认使用本机最新已安装的稳定版；开工时核对 `command -v bun` 与 `bun --version`，确保非交互 shell 解析到预期版本。不要为了匹配旧记录下载或切换旧版，也不要把“本机最新”理解为每次任务都执行全局升级。
- `package.json` 的 `engines.bun` 是最低支持版本；`packageManager` 是 CI 的可复现基准，不要求本地版本与之完全相等。CI 从 `package.json` 读取版本，避免多个位置重复硬编码。更新基准时先在本机完成相关验证。
- 项目依赖安装默认使用 `bun install --frozen-lockfile`。只有明确调整依赖时才用 `bun install` 或 `bun update` 更新 `bun.lock`，并将依赖声明和锁文件一起提交。Bun 运行时更新不意味着批量更新依赖。
- Cloudflare 操作统一使用全局 `cf`（Node.js >= 22.18）；先核对 `command -v cf`、`cf --version`。禁止直接使用 Wrangler CLI 或把 `cf` 安装到项目依赖。项目脚本从 PATH 调用全局 `cf`；官方 SvelteKit 适配器内部的传递兼容依赖不作为操作入口。命令先 `cf cli search`，再检查帮助和 dry-run；原生配置以 `cloudflare.config.ts` 及公开/私有 JSON target 为准。
- 库、SDK、CLI 或云服务的用法、配置和版本迁移先查 Context7：先 `resolve-library-id`，再用匹配的库 ID 调用 `query-docs`；用户给出精确 ID 时可直接查询。工具未列出时先发现工具，确认不可用后再用官方文档及已安装版本的帮助/类型核对。纯业务逻辑调试、重构和代码审查无需为此查询文档。
- 安装全局 JavaScript CLI 时依次优先 Bun、pnpm、npm，并确认非交互 shell 能找到二进制；不要将本机工具安装混入项目依赖更新。

## 构建、测试与开发命令

- `bun install --frozen-lockfile`：按现有锁文件安装依赖
- `bun run dev`：启动本地 SvelteKit 开发环境
- `bun run check`：执行类型检查与路由校验
- `bun run build`：构建 Cloudflare Workers 产物
- `bun run preview`：用全局 `cf dev` 本地预览 Worker
- `bun run test`：运行 `src/` 与 `scripts/` 的 Bun unit/integration 测试
- `bun run db:migrate:local`：顺序应用 `migrations/` 到本地 D1
- `bun run deploy:dry-run`：从公开本地配置生成临时配置，构建并校验 Worker 打包；不读取私有生产配置、不发布
- `bun run release:preflight -- --json`：检查干净提交及本地发布门禁，不执行远程部署或远程迁移
- `bun run deploy`：使用私有 `cloudflare.deploy.json` 构建并发布生产 Worker，仅在明确授权生产发布时使用

## 编码风格与命名约定

统一使用 TypeScript、ES Modules 和 2 空格缩进。遵循 SvelteKit 文件约定：页面使用 `+page.svelte`、服务端加载使用 `+page.server.ts`、接口使用 `+server.ts`。Cloudflare 绑定统一通过 `CloudflareEnv` 类型声明。服务端模块按职责命名，如 `email.ts`、`cloudflare.ts`。优先写小函数、显式返回结构，避免把平台相关逻辑散落到页面组件中。

## 数据库和绑定变更

- D1 migration 只追加，不修改已发布文件；同步 `schema.sql`、schema version 与相关类型/契约，同时验证空库、legacy fixture 和快照一致性。远程执行前核对目标、待应用列表、恢复点及当前生产代码兼容性，完成后核对迁移记录和 schema。
- 绑定或 compatibility date/flags 变更同步相关公开配置/模板；运行 `bun run cf:typegen` 更新 `worker-configuration.d.ts`，不要手改生成类型。私有部署配置按目标环境核对，不复制真实资源标识到公开文件。

## 安全与配置提示

不要提交真实的 Cloudflare 凭据、`databaseId`、生产桶名称或密钥。修改 `cloudflare.config.ts` / JSON target、`schema.sql`、邮件接收逻辑时，保持 D1、R2 与 API 字段定义一致。

私有 `.env`、`.dev.vars` 和部署配置保持 Git 忽略，密钥文件权限使用 `0600`。命令输出、截图和共享记录不得暴露密码、Token、Cookie、邮件正文或完整收件地址。未经明确授权不进行生产数据清理、恢复、资源删除、密钥轮换或邮件路由变更。

给用户访问的开发服务优先监听 `::` 并用 `ss -lntp` 核对 IPv4/IPv6；提供 `http://oc-de-fra-1.knowsky.uk:<port>`，不要提供只能在本机打开的 localhost 地址。无人使用的临时验证服务及时停止。

交付时区分本地/mock、CI、Preview、生产部署、远程迁移和真实供应商证据，报告已验证项、未验证项及提交 SHA，不把构建或健康检查成功扩展为真实收发信成功。
