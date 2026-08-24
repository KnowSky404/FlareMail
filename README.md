# FlareMail

<p align="center">
  <img src="./static/brand/flaremail-logo.svg" alt="FlareMail logo" width="286" />
</p>

FlareMail 是一个部署在 Cloudflare Workers 上的单工作区邮件客户端。一个 Worker composition root 同时承载 SvelteKit Web/API 的 `fetch()` 与 Cloudflare Email Routing 的 `email()`，D1 保存结构化数据和状态，R2 保存原始 `.eml` 与附件，生产外发统一使用 Resend。

仓库固定使用 Bun `1.3.14`。CI 和本地测试均可从没有 `.svelte-kit`、`build`、`.wrangler` 产物的 clean checkout 开始；`tsconfig.json` 保留 `$lib` 的显式源代码映射，避免测试命令依赖先启动过 SvelteKit。

## 已实现能力

- Cloudflare Email Routing 入站：一次性读取 raw stream、大小限制、SHA-256 去重、RFC threading、MIME/中文/附件解析。
- D1/R2 持久化：入站原文与带 SHA-256 的附件、用户归属、已读/星标、归档、批量邮箱操作、草稿、已发送、投递状态和事件时间线；下载在返回 bytes 前验证 ownership、size 与 checksum。
- Resend 出站：稳定幂等键、`reply_to`/RFC headers、R2 流式附件上传与完整性校验、错误分类、重试，以及 `submitted` 与 `delivered` 的严格语义区分。
- Resend webhook：Svix 签名与时间窗口校验、事件去重、乱序保护、未知事件保留，以及退信/投诉/抑制等终态。
- 单管理员认证：PBKDF2 密码哈希、D1 session token hash/expiry、Cookie、Origin/CSRF、登录限速和安全响应头。
- 响应式工作台：桌面三栏、平板/手机 drill-in、搜索与筛选、线程、详情、入站/出站附件下载、拖放/粘贴附件、纯文本回退与可选 HTML 写信、自动保存、草稿冲突提示、归档/恢复与批量读写操作、主题和键盘快捷键。
- 版本化 D1 migration：`migrations/0001` 至 `0018`，包括登录与出站发送限速、schema metadata、inbound claim、归档/垃圾箱、收件元数据、FTS5、出站附件与 lease/retry/manual-review 清理队列，并由 `schema.sql` 保存最新结构快照。
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

### 本地 Email Routing 入站验证

`bun run dev` 主要用于页面开发；要执行 Worker 的 `email()` handler，请使用
`bun run preview`。本地入口是
`/cdn-cgi/handler/email?from=...&to=...`，POST body 必须是完整的 RFC5322
原文而不是 JSON。`to` 必须与本地 bootstrap 的
`FLAREMAIL_ADMIN_EMAIL` 一致，否则邮件会保存为未归属记录。生产部署顺序请
使用 [DEPLOY.md](./DEPLOY.md)，不要套用本地 `demo` provider。

本地 `OUTBOUND_PROVIDER=demo`/`fake` 只验证 UI、D1/R2 和状态机，不访问 Resend，
也不证明 DNS、真实投递或 `delivered`。只有 signed `email.delivered` webhook
才是生产送达证据。

## 本地验证

```bash
bun install --frozen-lockfile
bun run db:migrate:local
bun test
bun run check
bun run build
```

浏览器验证使用隔离的本地 D1/R2 与 fake provider：

```bash
bun run test:e2e
bun run test:e2e:webkit
bun run test:a11y
```

`deploy:dry-run` 只从公开 development config 生成临时配置，不读取私有生产
配置，也不会发布 Worker。Linux Playwright WebKit 不是真实 iOS/iPadOS Safari
证据。

## 生产部署

请从 [DEPLOY.md](./DEPLOY.md) 开始；它是完整的首次生产部署、升级、Custom
Domain、Resend、D1 Time Travel 与 Email Routing 顺序的唯一权威说明。

维护、FTS 导出、cleanup 和 incident recovery 见
[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)；可勾选的 release gate 见
[docs/PRODUCTION_CHECKLIST.md](./docs/PRODUCTION_CHECKLIST.md)。

## 文档

- [品牌资源与 logo 来源记录](./docs/design-concepts/flaremail-logo/README.md)：生产 SVG、favicon 及设计概念素材说明。
- [DESIGN.md](./DESIGN.md)：权威设计系统与响应式/可访问性规则。
- [REFACTOR_PLAN.md](./REFACTOR_PLAN.md)：阶段实施、回滚点和最终验收边界。
- [DEPLOY.md](./DEPLOY.md)：权威生产首次部署、升级、回滚与 smoke test。
- [docs/API.md](./docs/API.md)：工作区 snapshot、邮箱分页、草稿并发、批量操作和投递重试契约。
- [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)：维护 dry-run、stale claim 和投递 review 报告。
- [docs/RUNTIME_BUDGET.md](./docs/RUNTIME_BUDGET.md)：Workers CPU 预算与 preview 人工测量流程。
- [docs/PRODUCTION_CHECKLIST.md](./docs/PRODUCTION_CHECKLIST.md)：所有未来生产 release 的审批与回滚操作门禁。
- [docs/RC1_RELEASE.md](./docs/RC1_RELEASE.md)：RC-1 行为、schema、验证边界与残余风险。
- [docs/SLO.md](./docs/SLO.md)：建议性 SLO、阻塞阈值与无 PII 可观测性契约。
- [TODO.md](./TODO.md)：重构完成后的剩余产品路线。
- [GEMINI_UI_PROMPT.md](./GEMINI_UI_PROMPT.md)：已归档的旧视觉提示，不再是实现依据。
