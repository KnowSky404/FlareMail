# FlareMail

[English README](./README.en.md)

<p align="center">
  <img src="./static/brand/flaremail-logo.svg" alt="FlareMail logo" width="286" />
</p>

FlareMail 是一个部署在 Cloudflare Workers 上的个人自托管邮件工作区。一个稳定 Owner 管理多个显式配置的域名和邮件地址；邮件地址只是收发资源，不是登录账号。一个 Worker composition root 同时承载 SvelteKit Web/API 的 `fetch()` 与 Cloudflare Email Routing 的 `email()`，D1 保存结构化数据和状态，R2 保存原始 `.eml` 与附件，生产外发使用 Resend。

仓库固定使用 Bun `1.4.0`。CI 和本地测试均可从没有 `.svelte-kit`、`build`、`.wrangler` 产物的 clean checkout 开始；`tsconfig.json` 保留 `$lib` 的显式源代码映射，避免测试命令依赖先启动过 SvelteKit。

## 已实现能力

- Cloudflare Email Routing 入站：一次性读取 raw stream、大小限制、SHA-256 去重、RFC threading、MIME/中文/附件解析。
- D1/R2 持久化：入站原文与带 SHA-256 的附件、用户归属、已读/星标、归档、批量邮箱操作、草稿、已发送、投递状态和事件时间线；下载在返回 bytes 前验证 ownership、size 与 checksum。
- Resend 出站：稳定幂等键、`reply_to`/RFC headers、R2 流式附件上传与完整性校验、错误分类、重试，以及 `submitted` 与 `delivered` 的严格语义区分。
- Resend webhook：Svix 签名与时间窗口校验、事件去重、乱序保护、未知事件保留，以及退信/投诉/抑制等终态。
- 明确的 `AUTH_MODE=local|cloudflare-access` 认证：本地用户名（无需邮箱）和 PBKDF2 密码，或验签后的 Cloudflare Access 身份映射到相同稳定 Owner；两种模式共用 D1 会话吊销、Cookie、Origin/CSRF、登录限速和安全响应头。
- 多域名邮件身份：域名通过受控配置显式加入；地址路由只使用限定 zone 的 Cloudflare Email Routing Rules API 精确规则。收件在读取正文/R2 前按信封收件人解析地址，统一邮箱支持服务端域名/地址筛选，搜索、计数、分页和草稿使用同一筛选范围。批量操作默认只修改已选的已加载邮件；筛选内会话和跨 Owner 地址的完整会话均需明确选择，回收站始终是 Owner 全局视图。
- 多发件身份：每封新邮件、回复、草稿和重试都携带受管地址 ID；服务端检查 Owner、地址状态和域级 Resend 发信验证，再固定 From/签名快照。旧 `OUTBOUND_FROM_EMAIL` / `MAIL_FROM` 仅供系统自动回复和通知使用。
- 响应式阅读工作台：桌面三栏、可折叠侧栏、280–480 px 可拖拽/键盘调整的邮件列表、标准/紧凑显示密度、平板/手机 drill-in、近全屏专注阅读和 `/messages/[id]` 独立阅读地址；列表宽度会在详情区可用空间不足时临时收窄，按 Enter 可恢复 360 px 默认值；同一用户打开的窗口只同步邮件状态信号，不传播正文、地址或凭据。
- 双语界面：服务端按安全 locale cookie（显式语言或跟随浏览器）以及 `Accept-Language` 首屏选择 zh-CN 或 en，浏览器端支持显式语言、跟随浏览器和持久化；日期、数字、计数和辅助标签随语言更新，邮件主题、地址、正文与附件文件名保持原文。
- 版本化 D1 migration：`migrations/0001` 至 `0026`。`0023` 将稳定 Owner 与本地用户名/凭据分开，`0024` 添加受管域名/地址和邮件身份快照，`0025` 添加独立的 Cloudflare/Resend 健康续检租约，`0026` 记录地址删除策略；历史邮件不会因资料邮箱或旧登录邮箱自动变成可收发地址。`schema.sql` 是最新结构快照。
- 地址删除会先展示只读远端规则/catch-all 预览，再由用户选择移除 FlareMail 精确规则或保留该规则作为 tombstone 拒收入口；导入规则保持不变，历史邮件和 R2 内容保留。删除某条精确规则不能阻止另一个外部 catch-all。
- 历史地址关联保留显式 `mail:identity:dry-run` 审计，并提供默认只读的本地 plan/apply/verify 工具：只按已归属同一 Owner 的入站信封收件人回填，限定明确选择的地址；旧外发 From 和草稿不自动关联，计划绑定 schema、地址、隔离本地 D1 路径与 24 小时有效期。工具拒绝 `--remote`。
- 无人值守域名续检：现有每分钟 Cron 保持 Telegram outbox 调度，另外按索引到期队列每次最多检查一个 Cloudflare 域名和一个 Resend 域名；成功后 16–20 小时再查，失败保留上次成功时间并退避。`/api/readiness` 只向登录 Owner 显示供应商状态；公开 `/api/health` 不变。临时 Cloudflare 健康错误只对曾明确授权的 `collect` 域名提供最多额外 24 小时的收集宽限，不延长成功时间。
- Telegram 入站通知：一个部署级 Bot、每个工作区用户一个私聊绑定、一次性深链确认、隐私/摘要开关、D1 durable outbox、每分钟 Cron、429/backoff/unknown-delivery 状态和现有邮件详情链接；实现边界与真实投递验证见 [docs/TELEGRAM.md](./docs/TELEGRAM.md)。
- 工作区 API：active folder snapshot 只加载当前邮箱页，指标只请求一次；入站列表不携带正文；Wrangler 生成的 `worker-configuration.d.ts` 是 Cloudflare binding 类型权威来源，并由 CI 检查同步。
- 可观测与维护：请求关联 ID、Workers logs/traces、只读优先的 D1/R2 retention/orphan 报告，以及有界 claim、lease、backoff、max-attempts 和人工复核的 canonical R2 cleanup lifecycle。
- 隔离浏览器验证：Playwright 在操作系统临时目录创建独立 D1/R2 状态，使用 fake provider 和签名 webhook 覆盖 Chromium 桌面/移动/320px、axe，以及 Desktop WebKit、iPhone 与 iPad 模拟 smoke。

## 运行环境边界

| 环境 | 出站 provider | 数据与凭据 | 约束 |
| --- | --- | --- | --- |
| development/test | 显式 `demo`/fake | 本地 D1/R2；管理员需 bootstrap | 必须设置 `ALLOW_FAKE_SERVICES=true` |
| preview | 按私有配置 | 独立 preview 资源 | 不应复用生产凭据或 D1 |
| production | 仅 `resend` | 真实 D1/R2 与 Wrangler secrets | 缺少必要 binding/secret 时 fail closed |

仓库不包含固定登录密码。使用 `scripts/bootstrap-admin.ts` 将 Owner 的本地用户名/凭据写入本地或远程 D1；登录名使用 `FLAREMAIL_ADMIN_USERNAME`，资料邮箱 `FLAREMAIL_PROFILE_EMAIL` 可选且不授予收发信权限。Access-only 初始化可通过 `bun run auth:bootstrap:access` 建立同一稳定 Owner，而无需设置本地密码。

本地 `wrangler.toml` 默认启用 demo provider，目的仅是验证 UI 与本地持久化。它不代表生产发送成功，也不会证明真实 Resend、Email Routing 或远程 Cloudflare 资源可用。

仓库中的 `wrangler.toml`、`wrangler.build.toml` 和 `wrangler.deploy.toml.example` 统一使用 `compatibility_date = "2026-08-19"` 与 `compatibility_flags = ["nodejs_compat"]`。修改 Worker 运行时版本时请同步三个配置，并运行 `bun run cf:typegen` 更新生成类型。

## 架构

```text
worker/index.ts
├── fetch  -> SvelteKit build/_worker.js
├── email  -> src/lib/server/email.ts
└── scheduled -> Telegram outbox + independently isolated mail health refresh

src/lib/domain/mail/           纯邮件领域契约、线程、写信、投递状态与校验
src/lib/client/                typed API client、请求竞态与快捷键/草稿控制器
src/lib/server/auth/           密码、session、CSRF、限速
src/lib/server/db/             D1 repositories
src/lib/server/inbound/        MIME 解析
src/lib/server/outbound/       Resend/fake gateway
src/lib/server/workspace/      mailbox、draft、outbound、delivery use cases
src/lib/components/{ui,shell,mail}/
src/routes/api/                thin SvelteKit API routes
src/routes/messages/[id]/      owner-scoped standalone message reader
src/lib/i18n/                   typed zh-CN/en catalog and locale context
migrations/                    顺序、不可变的 D1 migrations
schema.sql                     最新 schema 快照
```

## 本地开发

```bash
bun install
bun run audit:dependencies
bun run db:migrate:local
```

在当前 shell 设置本地管理员用户名和密码，不要把密码保存到项目 `.env`：

```bash
export FLAREMAIL_ADMIN_USERNAME='flower'
export FLAREMAIL_ADMIN_NAME='FlareMail Administrator'
export FLAREMAIL_ADMIN_PASSWORD='use-a-long-local-password'
bun run auth:bootstrap:local
unset FLAREMAIL_ADMIN_USERNAME FLAREMAIL_ADMIN_NAME FLAREMAIL_ADMIN_PASSWORD
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
原文而不是 JSON。`to` 必须匹配显式受管域名中的启用地址，或符合域名已核实的 collect 策略；登录用户名和资料邮箱不决定收件归属。用 `bun run mail:domain:configure` 配置本地测试域名，再通过身份设置或测试 fixture 添加地址。生产部署顺序请
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
证据。若本机未安装 Playwright 浏览器，`test:e2e`、`test:e2e:webkit` 和
`test:a11y` 会在浏览器启动阶段失败；这不等同于应用构建或单元测试失败。

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
- [docs/adr/0014-owner-managed-mail-identities-and-access.md](./docs/adr/0014-owner-managed-mail-identities-and-access.md)：稳定 Owner、认证模式、多邮件身份与收件路由的架构决策。
- [docs/API.md](./docs/API.md)：工作区 snapshot、邮箱分页、草稿并发、批量操作和投递重试契约。
- [docs/TELEGRAM.md](./docs/TELEGRAM.md)：Telegram Bot、绑定、Webhook、outbox、Cron、隐私、限速与生产运维边界。
- [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)：维护 dry-run、stale claim 和投递 review 报告。
- [docs/RUNTIME_BUDGET.md](./docs/RUNTIME_BUDGET.md)：Workers CPU 预算与 preview 人工测量流程。
- [docs/PRODUCTION_CHECKLIST.md](./docs/PRODUCTION_CHECKLIST.md)：所有未来生产 release 的审批与回滚操作门禁。
- [docs/READING_SPACE_QA.md](./docs/READING_SPACE_QA.md)：阅读工作台的尺寸契约、浏览器验证结果与证据边界。
- [docs/RC1_RELEASE.md](./docs/RC1_RELEASE.md)：RC-1 行为、schema、验证边界与残余风险。
- [docs/SLO.md](./docs/SLO.md)：建议性 SLO、阻塞阈值与无 PII 可观测性契约。
- [TODO.md](./TODO.md)：重构完成后的剩余产品路线。
- [GEMINI_UI_PROMPT.md](./GEMINI_UI_PROMPT.md)：已归档的旧视觉提示，不再是实现依据。
