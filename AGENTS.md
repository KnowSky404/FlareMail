# Repository Guidelines

## 项目结构与模块组织

`src/` 是 SvelteKit 主应用目录。页面放在 `src/routes/`，接口使用 `+server.ts`，例如 `src/routes/api/messages/+server.ts`。仅服务端可用的 Cloudflare 逻辑放在 `src/lib/server/`。Worker 包装入口位于 `worker/index.ts`，统一承载网页/API 的 `fetch` 与 Email Routing 的 `email()`。D1 表结构定义在 `schema.sql`。`build/`、`.svelte-kit/`、`.wrangler/` 均为构建产物，不要手改。

## 构建、测试与开发命令

- `bun install`：安装依赖并更新 `bun.lock`
- `bun run dev`：启动本地 SvelteKit 开发环境
- `bun run check`：执行类型检查与路由校验
- `bun run build`：构建 Cloudflare Workers 产物
- `bun run preview`：用 Wrangler 本地预览 Worker
- `bun run db:migrate:local`：将 `schema.sql` 应用到本地 D1
- `bun run deploy`：构建并部署到 Cloudflare

提交前至少运行 `bun run check`；涉及 Worker、D1、R2 或 Email Routing 时，再执行 `bun run build` 或 `bun run preview`。

## 编码风格与命名约定

统一使用 TypeScript、ES Modules 和 2 空格缩进。遵循 SvelteKit 文件约定：页面使用 `+page.svelte`、服务端加载使用 `+page.server.ts`、接口使用 `+server.ts`。Cloudflare 绑定统一通过 `CloudflareEnv` 类型声明。服务端模块按职责命名，如 `email.ts`、`cloudflare.ts`。优先写小函数、显式返回结构，避免把平台相关逻辑散落到页面组件中。

## 测试与验证要求

仓库当前未接入专门的单元测试框架，因此 `bun run check` 与 `bun run build` 是默认必跑项。新增测试时，建议与目标模块相邻放置，并使用 `*.test.ts` 命名。接口变更应至少补充一条本地验证路径，例如 `GET /api/health`。

## 提交与 Pull Request 规范

每次改动完成后都必须立即执行一次 `git commit`，不要把多个不相关改动混入同一提交。提交信息必须符合业务开发最佳实践，推荐使用 `type(scope): summary`，例如 `feat(email): persist inbound message metadata`、`fix(api): handle missing D1 binding`、`docs(repo): update contributor rules`。PR 需说明变更目的、影响范围、验证命令；涉及 UI 时附截图，涉及 D1 或 Wrangler 绑定时写清迁移和配置变更。

## 安全与配置提示

不要提交真实的 Cloudflare 凭据、`database_id`、生产桶名称或密钥。修改 `wrangler.toml`、`schema.sql`、邮件接收逻辑时，保持 D1、R2 与 API 字段定义一致。
