# FlareMail

FlareMail 是一个部署在 Cloudflare Workers 上的单工作区邮件客户端。一个 Worker composition root 同时承载 SvelteKit Web/API 的 `fetch()` 与 Cloudflare Email Routing 的 `email()`，D1 保存结构化数据和状态，R2 保存原始 `.eml` 与附件，生产外发统一使用 Resend。

仓库固定使用 Bun `1.3.14`。CI 和本地测试均可从没有 `.svelte-kit`、`build`、`.wrangler` 产物的 clean checkout 开始；`tsconfig.json` 保留 `$lib` 的显式源代码映射，避免测试命令依赖先启动过 SvelteKit。

## 已实现能力

- Cloudflare Email Routing 入站：一次性读取 raw stream、大小限制、SHA-256 去重、RFC threading、MIME/中文/附件解析。
- D1/R2 持久化：入站原文与带 SHA-256 的附件、用户归属、已读/星标、归档、批量邮箱操作、草稿、已发送、投递状态和事件时间线；下载在返回 bytes 前验证 ownership、size 与 checksum。
- Resend 出站：稳定幂等键、`reply_to`/RFC headers、R2 流式附件上传与完整性校验、错误分类、重试，以及 `submitted` 与 `delivered` 的严格语义区分。
- Resend webhook：Svix 签名与时间窗口校验、事件去重、乱序保护、未知事件保留，以及退信/投诉/抑制等终态。
- 单管理员认证：PBKDF2 密码哈希、D1 session token hash/expiry、Cookie、Origin/CSRF、登录限速和安全响应头。
- 响应式工作台：桌面三栏、平板/手机 drill-in、搜索与筛选、线程、详情、入站/出站附件下载、拖放/粘贴附件、纯文本写信、自动保存、草稿冲突提示、归档/恢复与批量读写操作、主题和键盘快捷键。
- 版本化 D1 migration：`migrations/0001` 至 `0017`，包括登录限速、schema metadata、inbound claim、归档/垃圾箱、收件元数据、FTS5、出站附件与 lease/retry/manual-review 清理队列，并由 `schema.sql` 保存最新结构快照。
- 工作区 API：active folder snapshot 只加载当前邮箱页，指标只请求一次；入站列表不携带正文；Wrangler 生成的 `worker-configuration.d.ts` 是 Cloudflare binding 类型权威来源，并由 CI 检查同步。
- 可观测与维护：请求关联 ID、Workers logs/traces、只读优先的 D1/R2 retention/orphan 报告，以及有界 claim、lease、backoff、max-attempts 和人工复核的 canonical R2 cleanup lifecycle。
- 隔离浏览器验证：Playwright 在操作系统临时目录创建独立 D1/R2 状态，使用 fake provider 和签名 webhook 覆盖 Chromium 桌面/移动/320px、axe，以及 Desktop WebKit、iPhone 与 iPad 模拟 smoke。

## 运行环境边界

| 环境 | 出站 provider | 数据与凭据 | 约束 |
| --- | --- | --- | --- |
| development/test | 显式 `demo`/fake | 本地 D1/R2；管理员需 bootstrap | 必须设置 `ALLOW_FAKE_SERVICES=true` |
| preview | 按私有配置 | 独立 preview 资源 | 不应复用生产凭据或 D1 |
| production | 仅 `resend` | 真实 D1/R2 与 Wrangler secrets | 缺少必要 binding/secret 时 fail closed |

仓库不包含固定登录密码。使用 `scripts/bootstrap-admin.ts` 将管理员凭据安全写入本地或远程 D1；密码只通过当前 shell 环境变量传入，不写入配置文件。

本地 `wrangler.toml` 默认启用 demo provider，目的仅是验证 UI 与本地持久化。它不代表生产发送成功，也不会证明真实 Resend、Email Routing 或远程 Cloudflare 资源可用。

仓库中的 `wrangler.toml`、`wrangler.build.toml` 和 `wrangler.deploy.toml.example` 统一使用 `compatibility_date = "2026-08-19"` 与 `compatibility_flags = ["nodejs_compat"]`。修改 Worker 运行时版本时请同步三个配置，并运行 `bun run cf:typegen` 更新生成类型。

## 架构

```text
worker/index.ts
├── fetch  -> SvelteKit build/_worker.js
└── email  -> src/lib/server/email.ts

src/lib/domain/mail/           纯邮件领域契约、线程、写信、投递状态与校验
src/lib/client/                typed API client、请求竞态与快捷键/草稿控制器
src/lib/server/auth/           密码、session、CSRF、限速
src/lib/server/db/             D1 repositories
src/lib/server/inbound/        MIME 解析
src/lib/server/outbound/       Resend/fake gateway
src/lib/server/workspace/      mailbox、draft、outbound、delivery use cases
src/lib/components/{ui,shell,mail}/
src/routes/api/                thin SvelteKit API routes
migrations/                    顺序、不可变的 D1 migrations
schema.sql                     最新 schema 快照
```

## 本地开发

```bash
bun install
bun run audit:dependencies
bun run db:migrate:local
```

在当前 shell 交互式设置管理员信息，不要把密码保存到项目 `.env`：

```bash
export FLAREMAIL_ADMIN_EMAIL='admin@example.test'
export FLAREMAIL_ADMIN_NAME='FlareMail Administrator'
export FLAREMAIL_ADMIN_PASSWORD='use-a-long-local-password'
bun run auth:bootstrap:local
unset FLAREMAIL_ADMIN_EMAIL FLAREMAIL_ADMIN_NAME FLAREMAIL_ADMIN_PASSWORD
```

启动开发或 Worker 预览：

```bash
bun run dev
bun run preview
```

## 验证

```bash
bun install --frozen-lockfile
bun test
bun run test:unit
bun run test:integration
bun run test:remaining
bun run check
bun run cf:typegen -- --check
bun run build
bun run db:migrate:local
bun run search:index -- --mode verify --json
bun run release:preflight
bun run release:preflight -- --json
bun run test:e2e
bun run test:e2e:webkit
bun run test:a11y
bun run deploy:dry-run
git diff --check
```

`deploy:dry-run` 从 checked-in development config 在操作系统临时目录生成结构合法、无效资源 ID、无 secret 的 CI 配置；不需要也不会读取私有 `wrangler.deploy.toml`，只构建和校验 Worker，不会发布。

Wrangler 远程命令继承当前 OAuth keyring 或 `CLOUDFLARE_API_TOKEN` 环境；本地命令的隔离目录和 dry-run 输出均通过操作系统临时目录生成，因此同一组 `bun run` 命令可由 PowerShell、cmd、bash 或 zsh 调用。

`test:e2e`/`test:e2e:webkit`/`test:a11y` 不读取生产配置、不调用真实 Resend，也不会访问远程 D1/R2。每个浏览器项目使用独立端口与临时状态；Linux Playwright WebKit 结果不等同于真实 iOS/iPadOS Safari 验证。

本地 `bun test` 聚合运行完整 `src/` 与 `scripts/` 集合；CI 的 unit、integration、remaining 三组互不重叠并合计覆盖同一集合，避免重复执行掩盖分组遗漏。

运维清理默认仅生成报告；只有显式 `--remote` 才访问远程资源，只有再加 `--apply` 才执行经过范围保护的删除：

```bash
bun run maintenance -- --config wrangler.toml
bun run maintenance -- cleanup-report --config wrangler.toml --json
bun run attachment:integrity -- --limit 100 --json
bun run search:index -- --mode verify --json
```

附件修复和 cleanup drain 默认 local、bounded、report-only。远程只接受显式 `APP_ENV=preview` 的独立配置；`--apply` 必须再次显式给出，production 目标由命令硬拒绝。

邮件搜索使用 owner-scoped D1 FTS5，支持 `from:`、`to:`、`cc:`、`subject:`、
`is:`、`has:attachment`、`after:`、`before:`、`status:` 与 `label:`。索引校验
默认只读且只访问本地 D1；重建必须显式加 `--mode rebuild --apply`。

## 部署安全

- 不提交真实 Cloudflare token、D1 ID、生产桶名、邮箱凭据或 Resend secrets。
- 生产部署只使用不入库的 `wrangler.deploy.toml`。
- 先备份并应用远程 migrations，再 bootstrap 管理员和部署。
- `RESEND_API_KEY` 与 `RESEND_WEBHOOK_SECRET` 必须使用 Wrangler secret 注入。
- Resend webhook endpoint 为 `/api/webhooks/resend`。
- 生产 smoke test、真实邮件与远程 migration 必须由操作者显式执行并保留证据。

## 文档

- [DESIGN.md](./DESIGN.md)：权威设计系统与响应式/可访问性规则。
- [REFACTOR_PLAN.md](./REFACTOR_PLAN.md)：阶段实施、回滚点和最终验收边界。
- [DEPLOY.md](./DEPLOY.md)：生产配置、migration、回滚与 smoke test。
- [docs/API.md](./docs/API.md)：工作区 snapshot、邮箱分页、草稿并发、批量操作和投递重试契约。
- [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)：维护 dry-run、stale claim 和投递 review 报告。
- [docs/RUNTIME_BUDGET.md](./docs/RUNTIME_BUDGET.md)：Workers CPU 预算与 preview 人工测量流程。
- [docs/PRODUCTION_CHECKLIST.md](./docs/PRODUCTION_CHECKLIST.md)：RC-1 Preview、生产审批与回滚操作门禁。
- [docs/RC1_RELEASE.md](./docs/RC1_RELEASE.md)：RC-1 行为、schema、验证边界与残余风险。
- [docs/SLO.md](./docs/SLO.md)：建议性 SLO、阻塞阈值与无 PII 可观测性契约。
- [TODO.md](./TODO.md)：重构完成后的剩余产品路线。
- [GEMINI_UI_PROMPT.md](./GEMINI_UI_PROMPT.md)：已归档的旧视觉提示，不再是实现依据。
