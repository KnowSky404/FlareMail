# FlareMail 全量重构执行计划

> 文档状态：11 个阶段与后续安全/质量收口已实施；本轮继续完成 mailbox archive/bulk、snapshot lazy loading、通知语义和生成类型收口；本文同时保留实施前基线、回滚点与最终证据边界
>
> 规范来源：`https://microbin.knowsky.uk/raw/egx53a`
>
> 调研/基线日期：2026-08-13（Europe/Berlin）
>
> 本文是重构期间的权威实施顺序；每一阶段都必须保留可构建主分支、产生独立提交，并在进入下一阶段前完成验证与回滚点确认。

## 0. 实施结果（2026-08-13）

11 个阶段已按顺序完成，随后又完成 mailbox cursor、runtime 安全、维护、D1 登录限速、provider endpoint、无障碍、草稿竞态、设置和 delivery detail 收口。阶段提交为：

1. `d38a524` `docs: add refactor plan and cloudflare-inspired design system`
2. `54dbab3` `refactor: extract mail domain and shared contracts`
3. `0d077d6` `refactor: split d1 repositories and workspace services`
4. `592b097` `feat: add versioned d1 migrations and secure auth`
5. `5d50840` `feat: harden cloudflare email routing ingestion`
6. `cc4fbea` `feat: make resend the production outbound gateway`
7. `aeb7019` `feat: reconcile resend webhooks and delivery state`
8. `8ec7c13` `feat: rebuild flaremail app shell and ui primitives`
9. `2f84096` `feat: complete responsive mailbox and compose flows`
10. `a2f0536` / `ef61f68`：真实 Chromium QA 发现并修复 D1 可选绑定、筛选状态泄漏、移动端溢出与嵌套 overlay 行为。
11. `b3736b4` `docs: finalize deployment and migration guide`

后续收口提交为 `c0e7072`、`3d292aa`、`933c298`、`6e54d98`、`317edb1`、`1a290c5`、`835ca4a`、`4234659`、`ac7382e`、`794ae22`、`a57dd4d`；最终文档同步在本轮 closeout 中完成。

实际 migrations 为 `0001_baseline`、`0002_mail_contracts`、`0003_auth_and_settings`、`0004_delivery_states`、`0005_operational_indexes`、`0006_inbound_ownership`、`0007_outbound_contracts`、`0008_login_rate_limits`、`0009_inbound_ingest_claims`、`0010_mailbox_archive_and_bulk`。`schema.sql` 已由自动测试验证与顺序应用结果一致；`workspace_schema_metadata` 由 `0010` 推进到版本 10，health readiness 会拒绝部分 schema。

最终本地 QA 使用提交到仓库的 Playwright harness，在操作系统临时目录创建隔离 D1/R2、fake gateway 与 Chromium；覆盖登录、服务端搜索/筛选/cursor、active-folder lazy snapshot、读信/星标/归档批量持久化、草稿自动保存与冲突、发送、签名 webhook、delivery timeline、主题/快捷键、手机详情/返回、320px/200% 缩放、axe WCAG 2.1 A/AA、44px 触控目标及 console error。CI 复用同一 harness。未执行生产部署、远程 migration、真实 Resend、真实 Email Routing 或真实邮件 smoke test。

## 1. 目标与范围

最终形态是一个仓库、一个 SvelteKit 应用、一个 Cloudflare Worker：同一入口同时提供 SvelteKit `fetch` 与 Cloudflare Email Routing `email`，D1 保存结构化邮件/状态，R2 保存原始 `.eml` 与入站附件，生产外发唯一走 Resend。

本轮覆盖：

- domain / service / repository / provider / UI primitive 分层；
- 正式、可顺序应用的 D1 migrations，并为现有数据提供非破坏性迁移；
- Cloudflare Email Routing 入站、一次性 raw stream、MIME/附件/幂等/安全展示；
- Resend 外发、幂等 key、RFC threading、submitted 与 delivered 语义、webhook 状态机；
- 单管理员安全认证、CSRF/Origin、session、CSP、安全下载和 fail-closed 环境校验；
- Cloudflare Dashboard 启发但不仿冒的紧凑响应式 UI、共享 primitives、light/dark/system、键盘及 WCAG 2.1 AA 基线；
- unit、MIME fixture、D1/R2 integration、Playwright E2E 与 dry-run 验证；
- 部署、迁移、回滚、排障和人工生产配置文档。

明确非目标：多租户、开放注册/邀请/复杂 RBAC、联系人、日历、完整反垃圾、富文本编辑器、外部全文搜索、Cloudflare Queues、营销群发和像素级复制 Cloudflare Dashboard。首版保持单管理员/单工作区，但边界不得阻碍未来扩展。

## 2. 当前架构基线

### 2.1 组件关系

```mermaid
flowchart LR
  Browser[Browser\n+page.svelte + mail components]
  Svelte[SvelteKit routes\n+SSR + /api/*]
  Worker[worker/index.ts\n+composition root]
  Adapter[build/_worker.js\n+adapter fetch]
  EmailHandler[src/lib/server/email.ts\n+inbound orchestration]
  Workspace[src/lib/server/workspace.ts\n+2303 lines god module]
  MIME[src/lib/server/inbound-email.ts\n+hand-written MIME parser]
  Outbound[src/lib/server/outbound.ts\n+demo/resend/cloudflare]
  CFEmail[src/lib/server/cloudflare-email.ts\n+native send_email]
  Webhook[src/lib/server/resend-webhook.ts]
  Mock[src/lib/mock/mailbox.ts\ntypes + domain + fixtures]
  D1[(D1\nschema.sql tables)]
  R2[(R2\nraw .eml)]
  Resend[Resend API/Webhook]
  Routing[Cloudflare Email Routing]

  Browser --> Svelte
  Worker -->|fetch| Adapter
  Svelte --> Workspace
  Svelte --> Mock
  Worker --> EmailHandler
  Routing -->|email(message, env, ctx)| Worker
  EmailHandler --> MIME
  EmailHandler --> D1
  EmailHandler --> R2
  Workspace --> D1
  Workspace --> Outbound
  Workspace --> Webhook
  Outbound --> CFEmail
  Outbound --> Resend
  Resend -->|webhook| Webhook
  Workspace --> Mock
```

### 2.2 已核实的证据

| 风险/事实 | 当前证据 | 影响 |
| --- | --- | --- |
| Worker 组合入口存在，但 `fetch` 指向构建产物，配置仍可能走另一条路径 | `worker/index.ts:1-13` 导入 `../build/_worker.js` 并导出 `fetch`/`email`；`wrangler.toml:1-3` 的 `main` 为 `build/_worker.js` | 需要明确唯一的 composition root 与 build/deploy 路径，避免 adapter 直部署和 wrapper 分叉 |
| God Module 混合全部领域职责 | `src/lib/server/workspace.ts` 共 2303 行；`workspace.ts:142-149` 有 memory session、legacy seed、demo profile，`workspace.ts:649-899` 有 D1 session/demo 初始化，`workspace.ts:1275-2211` 又包含认证、profile、draft、send、retry、patch、delete | 重构耦合高，必须以契约和阶段提交拆分，不能一次性删除旧路径 |
| 页面承担状态、网络和线程编排 | `src/routes/+page.svelte:1-30` 从 `$lib/mock/mailbox` 导入生产类型；`+page.svelte:69-196` 集中 20 余个状态/derived；`+page.svelte:400+` 直接 `fetch` API | UI 变更容易破坏 API/交互；需要 route/state/service 分离与 E2E 门禁 |
| mock 目录成为生产依赖 | `src/lib/mock/mailbox.ts:1-151` 同时定义 domain 类型、delivery 类型、登录输入和固定 `demoCredentials`；`src/lib/server/inbound-email.ts:1`、`outbound.ts:1`、`+page.svelte:30` 直接导入 | 生产 bundle 可带入 demo/fake 语义；domain 类型必须迁移到 `$lib/domain`，fake 只能显式注入 |
| 手写 MIME parser 覆盖有限 | `src/lib/server/inbound-email.ts:18-214` 手工处理 header、base64、quoted-printable、multipart；`inbound-email.ts:217+` 递归能力和 charset/边界不完整 | 可能错误解析嵌套 MIME、编码、附件和恶意内容；改用 Workers 兼容的 `postal-mime`，保留原文一次性 buffer |
| 生产外发默认可静默 demo，且 native sender 并存 | `src/lib/server/outbound.ts:8` provider 包含 `demo`/`resend`/`cloudflare`；`outbound.ts:45-50` 未知值回落 `demo`；`wrangler.toml:7` 为 `demo`，`wrangler.toml:26-29` 有 `send_email` | 生产可能“发送成功”但未真实发信；生产必须 fail closed 且只注入 Resend |
| REST 字段命名疑似错误 | `src/lib/server/outbound.ts:200-267` 的 Resend payload 在 `outbound.ts:237` 使用 `replyTo` | 必须按当日官方 API 确认 `reply_to`（或选择唯一官方 SDK），并加序列化测试 |
| API 受理与送达语义混淆 | `src/lib/server/outbound.ts:79-84` 将 `accepted` 映射为 `sent`；`resend-webhook.ts:191-205` 仅部分区分 `email.sent`/`email.delivered` | 状态机需要 `submitted`、`sent`、`delivered` 等独立状态，UI 不得提前声称送达 |
| webhook 错误重试策略不正确 | `src/routes/api/webhooks/resend/+server.ts:31-38` 将所有异常返回 400 | 签名无效应拒绝；D1/配置/临时服务错误应 5xx/503 以保留 Resend 重试机会 |
| webhook 事件覆盖不完整 | `resend-webhook.ts:102-127` switch 未显式处理 `email.suppressed`；未知类型需保存且安全忽略 | 要覆盖 suppressed、duplicate、unknown event 和 message ID mapping |
| 固定 demo 凭据与 memory fallback | `src/lib/mock/mailbox.ts:151-154` 固定密码；`workspace.ts:458-473` 创建 memory demo session；`workspace.ts:1292-1304` 对比固定凭据 | 不能作为生产认证；改为 PBKDF2/等价 KDF + D1 session hash + secure cookie，生产缺绑定直接失败 |
| 未认证路由和健康信息边界需审计 | `src/routes/api/messages/+server.ts:5-16` 只检查 DB binding；`src/routes/+page.svelte:72` 根据绑定状态显示“模拟模式” | 详细 D1/R2/provider 状态不能公开；所有 workspace/message/raw/download route 统一认证和 ownership |
| schema 是单体快照，不是版本化迁移 | 根目录仅有 `schema.sql:1-157`，无 `migrations/`；`package.json` 的 `db:migrate:local` 直接执行 `schema.sql` | 需要不可变顺序 migrations、local/remote apply 和旧 schema fixture 验证 |
| UI 与目标规范冲突 | `src/app.css:4-5` 含 serif display 字体；`app.css:31` 全局 `overflow:hidden`；`app.css:70-76` paper shadow/editorial heading；`GEMINI_UI_PROMPT.md:1-74` 是过时视觉约束 | 必须建立 DESIGN.md、tokens/primitives、响应式滚动与独立产品品牌，归档/删除旧 prompt |
| `bun install` 使锁文件根依赖与 `package.json` 重新同步 | 初始 `git status --short --branch` 为 clean；基线 `bun install` 输出 `Saved lockfile`，随后 `bun.lock` 显示 SvelteKit、Svelte、Wrangler 等根约束同步到当前 `package.json` | 这是基线安装产生的可解释漂移；只在实际新增测试/MIME/UI 依赖的阶段与依赖变更一起提交，不混入纯文档提交 |

### 2.3 当前基线命令记录

在代码修改前执行（2026-08-13，目录 `/root/Clouds/FlareMail`）：

```text
$ bun install
bun install v1.3.14 (0d9b296a)
Resolved, downloaded and extracted [20]
107 packages installed
Saved lockfile

$ bun run check
svelte-check found 0 errors and 0 warnings
exit 0

$ bun run build
vite v7.3.1 building ssr environment for production...
✓ built in 1.76s
✓ built in 8.70s
Using @sveltejs/adapter-cloudflare ✔ done
exit 0

$ git status --short --branch
## main...origin/main
 M bun.lock
```

说明：仓库在基线安装前是 clean；`bun install` 因锁文件根依赖落后于 `package.json` 而更新了 `bun.lock`。阶段 1 不提交它；后续在首次正式添加 `postal-mime`/测试依赖时一并核对并提交。每次提交前必须使用显式路径检查 staging。

## 3. 目标架构与模块边界

```text
src/lib/
├── domain/mail/
│   ├── types.ts             # 纯 TypeScript domain contracts
│   ├── thread.ts            # RFC headers 优先、subject fallback 的线程算法
│   ├── compose.ts           # new/reply/forward headers and payload
│   ├── delivery.ts          # state machine and monotonic transitions
│   └── validation.ts        # address, subject, body, filename limits
├── server/
│   ├── config/env.ts        # environment matrix and fail-closed checks
│   ├── auth/{password,session,csrf}.ts
│   ├── db/{d1,repositories/{users,sessions,messages,drafts,attachments,deliveries}}.ts
│   ├── email/
│   │   ├── inbound/{handler,parser,storage,dedupe}.ts
│   │   ├── outbound/{gateway,resend,service,retry}.ts
│   │   └── webhooks/resend.ts
│   ├── workspace/{mailbox-service,draft-service,profile-service,mappers}.ts
│   └── http/{api-error,response,request-id}.ts
├── components/{ui,shell,mail}/
└── dev/fixtures/
```

边界不变量：

1. `domain` 不依赖 SvelteKit、Cloudflare、D1、R2、Resend 或 `$lib/mock`。
2. `+server.ts` 只负责 auth、输入校验、调用 service、标准 JSON/error envelope；不拼大型 SQL、不调用 Resend、不实现线程算法。
3. repository 只负责 D1/R2 持久化与 query；service 负责 use case、`batch()` 原子写和补偿策略；provider 只负责外部 API/签名。
4. 生产只注入 `ResendOutboundGateway`；`FakeOutboundGateway`、fake repo 只在 `APP_ENV=development|test` 显式启用。
5. `worker/index.ts` 保持薄 composition root，最终明确委托 `fetch` 与 `email`，只留一条 build/deploy 入口。
6. UI 页面不再承载全局网络状态；URL 保存 folder/cursor/query/filter 等可深链接状态，组件通过 primitives 复用变体和可访问行为。

## 4. 非破坏性数据迁移策略

### 4.1 原则

- `schema.sql` 退化为最新 schema snapshot；生产和测试只通过递增、不可变 `migrations/NNNN_*.sql` 应用。
- 禁止在单个 migration 中直接 `DROP` 现有生产表；旧表至少保留一个完整发布周期。
- D1/R2 无跨产品事务：先写受控 R2，再以 `batch()` 写 D1；D1 失败时删除孤儿 R2 或登记可观测清理任务。
- 所有 backfill 可重复、分批、带计数校验；切换读取路径前必须比较 legacy/new 行数和关键字段。

### 4.2 建议顺序

1. `0001_baseline`：把当前 `schema.sql` 作为可重放基线，验证空库安装和当前表结构；不得改数据。
2. `0002_mail_contracts`：新增 RFC `message_id`、`in_reply_to`、`references`、`thread_key`、`direction`、`html_body`、dedupe key、attachment metadata、provider/idempotency 字段与必要索引；使用 nullable/default 保持旧写入兼容。
3. `0003_delivery_states`：扩展 outbound 状态/事件结构为 `draft/queued/submitting/submitted/sent/delivered/delayed/bounced/failed/complained/suppressed`，旧 `sent/failed/queued` 通过兼容映射读出。
4. `0004_backfill_legacy_mail`：从 `email_messages`、`workspace_messages`、`workspace_email_states` 回填新结构；以稳定旧 id 和 recipient/raw SHA 生成 dedupe；记录 `migration_backfill_runs`（批次、开始/结束、计数、错误）。
5. `0005_attachments_and_sessions`：新增附件、session hash/expiry、credential metadata 和必要唯一约束；旧 session 在切换前仍可只读验证。
6. 发布兼容 readers/writers：先双写新表与旧表（必要时），再只读新表；保留旧 API wrapper 和观察期。
7. 计数/抽样/回滚检查通过后，后续独立 migration 才能清理 legacy 写路径和旧冗余列；删除必须有备份、窗口和恢复命令文档。

每次远程 migration 前记录 `wrangler d1 migrations list/apply` 输出、数据库快照/备份策略、行数校验和提交 SHA。真实 Cloudflare migration、备份、恢复不在本次无凭据环境自动执行。

## 5. 严格执行顺序（规范 §17 的 11 个阶段）

以下序号、提交主题和回滚点不得重排；每阶段完成后执行阶段验证，失败则停在该阶段并回滚到本阶段提交前，不跨阶段掩盖问题。

### 阶段 1 — 文档与设计基线

提交：`docs: add refactor plan and cloudflare-inspired design system`

产物：本 `REFACTOR_PLAN.md`、根目录 `DESIGN.md`；记录官方 Cloudflare SvelteKit/Email/D1、Resend API/idempotency/webhook 文档版本与核对日期；更新或归档 `GEMINI_UI_PROMPT.md`。

验证：`git diff --check`；确认 Mermaid 当前架构、风险证据、目标边界、迁移策略、11 阶段顺序齐全；不运行真实部署/邮件。

独立回滚点：恢复阶段 1 新增/修改的文档即可；不触及 runtime/schema。

### 阶段 2 — Mail domain 与共享契约

提交：`refactor: extract mail domain and shared contracts`

产物：`src/lib/domain/mail/*`；从 `$lib/mock/mailbox` 移出类型、thread/compose/delivery/validation；生产模块不再导入 `mock`；旧导出暂时用薄兼容 wrapper。

验证：`bun run check`、`bun run build`、domain unit tests（thread RFC headers、reply/forward、validation、delivery transition）。

独立回滚点：保留旧 mock contracts 与导入兼容层，回退 domain import/新增文件，不触碰数据库。

### 阶段 3 — D1 repositories 与 workspace services

提交：`refactor: split d1 repositories and workspace services`

产物：`db/d1`、users/sessions/messages/drafts/attachments/deliveries repositories；`mailbox-service`、`draft-service`、`profile-service`、mappers；routes 变为 thin routes；删除 workspace 中重复 SQL/DTO/memory 生产 fallback。

验证：`bun run check`、`bun run build`；repository/service unit tests；API 标准 envelope、cursor/limit/query、ownership 检查；旧 API wrapper 能读旧数据。

独立回滚点：服务层可继续调用旧 workspace facade；只回退 facade wiring，不删除旧表或旧 endpoint。

### 阶段 4 — Versioned D1 migrations 与 secure auth

提交：`feat: add versioned d1 migrations and secure auth`

产物：`migrations/`、Wrangler `migrations_dir`、local/remote migration scripts；`env.ts`；PBKDF2-HMAC-SHA-256（随机 salt）或已验证的 Workers-compatible KDF；bootstrap admin 初始化脚本；D1 session token hash、expiry/logout/cleanup、`__Host-` secure cookie；Origin/CSRF、rate limit、CSP/security headers。

验证：empty DB/current legacy fixture migration、migration idempotency、password/session/CSRF tests；`bun run check`、`bun run build`；仅使用 fake secrets，不触发 remote apply。

独立回滚点：只启用新增 schema/认证并保留旧 session reader；认证切换可通过 feature flag/运维开关回退，禁止删除 legacy user/session 数据。

### 阶段 5 — Hardened Cloudflare Email Routing ingestion

提交：`feat: harden cloudflare email routing ingestion`

产物：`email/inbound/{handler,parser,storage,dedupe}`；采用 Workers 兼容 `postal-mime`；`message.raw` 只读取一次并限制 buffer；SHA-256/dedupe；R2 raw/附件与 D1 metadata；安全文件名、下载 ownership/content disposition；RFC headers/thread key；correlation ID、结构化安全日志、永久拒收与通知失败隔离。

验证：`bun run check`、`bun run build`；`tests/fixtures/eml/` 覆盖 plain/HTML alternative/中文/quoted-printable/base64/nested multipart/attachment/CID/missing Message-ID/duplicate/malformed/oversize；D1/R2 fake integration；不注入真实 Email Routing。

独立回滚点：保留旧 parser/storage 只读兼容和新 handler feature flag；新表和 R2 key 可回滚，既有 raw 不删除。

### 阶段 6 — Resend production outbound gateway

提交：`feat: make resend the production outbound gateway`

产物：唯一 `OutboundMailGateway`、typed Resend REST（或单一官方 SDK）实现、service/retry；from/to/cc/subject/text/optional html/reply_to/headers/tags/idempotency key；reply/forward RFC headers；移除生产 `send_email` 必需 binding和 Cloudflare native 默认；unknown provider/缺 secret 在 production 明确 503/fail closed，fake 仅 development/test。

验证：request serialization（特别 `reply_to`）、stable idempotency key、409/concurrent retry、timeout/non-JSON/4xx/5xx 分类、fake gateway send/retry tests；`bun run check`、`bun run build`、`bun run deploy:dry-run`（占位符配置）。不调用真实 Resend。

独立回滚点：Resend gateway 通过 provider injection 保持旧 demo 仅测试可用；回退 wiring 可恢复 UI，但不得恢复 production silent demo。

### 阶段 7 — Resend webhook 与 delivery state reconciliation

提交：`feat: reconcile resend webhooks and delivery state`

产物：状态机与单调终态保护；`email.sent/delivered/delivery_delayed/bounced/failed/complained/suppressed/opened/clicked`；unknown event 原样存储并忽略状态更新；Svix verifier、时间窗口、常量时间比较；`svix_id` 去重；provider message id ↔ RFC Message-ID/local id；webhook 400/401/503/500 分类。

验证：signature valid/invalid/expired、duplicate、unknown、suppressed、message mapping、out-of-order events、delivery timeline tests；endpoint integration 确认临时 D1 错误返回 5xx；`bun run check`、`bun run build`。不配置真实 webhook endpoint。

独立回滚点：新事件表追加写、旧 delivery reader 兼容；可关闭新状态读取但不丢弃已保存事件。

### 阶段 8 — App shell 与 UI primitives

提交：`feat: rebuild flaremail app shell and ui primitives`

产物：`DESIGN.md` 对应 `src/app.css` tokens；`components/ui` 的 Button/IconButton/TextField/TextArea/Select/Checkbox/Switch/Tabs/Badge/StatusBadge/Banner/Panel/EmptyState/Skeleton/Dialog/Drawer/Dropdown/Tooltip/Toast/Confirm；`components/shell` topbar/sidebar/mobile navigation/status menu；语义 landmarks、focus、ARIA、light/dark/system 首屏主题。

验证：`bun run check`、`bun run build`；Playwright component/route smoke；键盘 focus、200% zoom、reduced motion、对比度、无横向滚动；确认无 serif/editorial/paper/重阴影/旧黑色图标栏。

独立回滚点：保留旧 mail feature components 与 route data contract，只替换壳层入口；回退壳层不会触碰 domain/API/D1。

### 阶段 9 — Responsive mailbox 与 compose flows

提交：`feat: complete responsive mailbox and compose flows`

产物：folder header/search/filter、message list/item、detail/header/body/attachment、delivery timeline、compose dialog/sheet；URL folder/cursor/query/filter；autosave 状态、错误、dirty close confirm；桌面三栏、平板两级、手机 drill-in/back 与触控目标 ≥44px；plain text 默认，HTML sandbox/远程内容默认阻止。

验证：Playwright 登录→Inbox→read/star；draft autosave→refresh recovery；send fake Resend→submitted→webhook delivered；mobile folder→detail→back；主题和 keyboard shortcuts；`bun run check`、`bun run build`。

独立回滚点：旧页面作为路由级 fallback，保留新 API/服务可用；单独回退 UI 不回滚数据/外发状态。

### 阶段 10 — Full test coverage

提交：`test: add mail, persistence, webhook and e2e coverage`

产物：Vitest（或当日官方 Workers integration）配置与 `bun run test`、`test:unit`、`test:integration`、`test:e2e`；unit/domain、MIME fixtures、D1/R2 migrations/inbound/dedupe/state/draft/outbound/session integration、Playwright E2E；测试全用 fake/mocks。

验证：先分项再全套：`bun run test:unit`、`bun run test:integration`、`bun run test:e2e`、`bun run check`、`bun run build`；确认不存在真实 Resend、真实邮件、生产 D1/R2 依赖。

独立回滚点：测试仅新增配置/fixtures；失败时回退测试提交不会改变运行时。

### 阶段 11 — Deployment/migration guide finalization

提交：`docs: finalize deployment and migration guide`

产物：更新 `README.md`、`DEPLOY.md`、`TODO.md`（过时项归档），说明唯一入口/config、development/preview/test/production、secrets、D1 migration/backup/rollback、R2、Email Routing、Resend webhook、bootstrap admin、smoke test、troubleshooting、禁止提交真实 secret/ID；配置文件和模板唯一且一致。

验证：`bun run check`、`bun run build`、`bun run test`、`bun run deploy:dry-run`；逐项完成最终验收清单；只做本地 dry-run，不做生产 deploy/smoke/mail。

独立回滚点：文档可单独回退；若 dry-run 不通过，停止发布，不执行真实部署。

## 6. 安全与生产边界

- 不提交 Cloudflare API token、D1 `database_id`、R2 bucket 名称（若属生产敏感信息）、Resend API/webhook secret、真实邮箱凭据或 admin password；只提交 `.example` 占位符。
- development/test 可以注入 `FakeOutboundGateway`、fake D1/R2、fixture；必须由 `APP_ENV` 显式选择，并在 UI 标记开发模式。production 缺 D1/R2/Resend/认证配置时 fail closed，不回落 memory/demo。
- 绝不自动执行 `bun run deploy`、remote migration、真实 Resend API、真实 Email Routing smoke test 或发送真实邮件；仅在用户明确授权并提供专用资源后由人工执行。
- 入站二级通知失败不得丢弃合法入站；永久拒收仅用于明确超限/阻止规则；日志只记录 correlation ID、envelope、大小、结果、耗时和安全 provider IDs，不记录正文、附件、secret、完整 raw payload。
- 所有 mutating endpoint 做 Origin/CSRF 与 abuse/rate-limit；错误返回 typed code，不泄露 stack trace、用户存在性或 binding/secret 详情；raw/attachment 下载做 session + ownership + safe `Content-Type`/`Content-Disposition`。
- 不信任 HTML：plain text 默认，HTML 仅 sandbox iframe 或经过可证明 Workers-compatible sanitization；默认阻止远程图片/追踪像素，外链使用 `noopener noreferrer`。
- 生产外发单一路径是 Resend；API 2xx 仅 `submitted`，`email.delivered` webhook 才能展示 delivered；retry 永远复用持久化 idempotency key 和原 payload。

## 7. 完成定义（Definition of Done）

只有全部项目都有代码、测试或文档证据时才可宣称完成：

### Runtime / deploy

- [x] 一个明确的 Worker composition root 同时提供 `fetch` 与 `email`。
- [x] 只有一条 build/deploy/dry-run 路径；Wrangler 使用同一入口、D1 migrations、R2 与 assets 配置。
- [x] production 缺配置时 fail closed，无静默 memory/demo fallback；生产外发只走 Resend。

### Inbound / data

- [x] postal-mime 覆盖 plain/alternative/中文/编码/nested/附件/CID/malformed/oversize fixture；raw stream 只读一次并受大小限制。
- [x] raw `.eml`/附件进入 R2，D1 元数据/ownership/安全下载可验证；R2/D1 失败有补偿。
- [x] dedupe key、RFC message headers、thread key、provider/message IDs、svix ID 有约束/索引和测试。
- [x] migrations 可从空库和当前 legacy fixture 顺序应用；有字段/快照校验、兼容读取和可执行恢复说明；无无备份 DROP。

### Outbound / webhook

- [x] 所有 compose/reply/forward/auto-reply/notification/retry 通过一个 gateway/service。
- [x] payload 字段命名、`reply_to`、headers、tags、idempotency、409/timeout/error 分类有测试；不触发真实 API。
- [x] `submitted`/`sent`/`delivered`/delayed/bounced/failed/complained/suppressed 语义准确，webhook 签名、时间窗口、去重、unknown event、out-of-order 有测试。

### Auth / API / security

- [x] 无生产硬编码 demo credential；password hash、session hash/expiry/logout、`__Host-` cookie、CSRF/Origin、rate limit、CSP/security headers、typed errors、ownership 下载有测试或代码证据。
- [x] workspace routes 是 thin routes，认证失败不泄露 binding/secret 诊断。
- [x] 服务端 mailbox query/filter/cursor 与 typed envelope 已实现并有 integration/E2E 证据；大规模全文检索仍可在后续升级为 FTS。

### Frontend / accessibility

- [x] `DESIGN.md` 权威且与实现同步；共享 primitives 统一变体，桌面/平板/手机流程可用。
- [x] light/dark/system 在首屏前生效；邮件正文默认只安全渲染 plain text；附件、delivery timeline、compose autosave/error 可见。
- [x] Chromium 核心流程验证键盘快捷键、Dialog/Drawer focus、ARIA role、触控主操作、移动端无横向滚动和 reduced-motion CSS。
- [x] axe WCAG 2.1 A/AA（light/dark）、44px 触控目标、320px 与模拟 200% zoom 已自动化；真实屏幕阅读器仍需生产发布前人工抽查。

### Quality / evidence

- [x] `bun run check`、`bun test`、`bun run build`、`bun run deploy:dry-run` 通过；unit/integration 与临时隔离 Playwright QA 有报告。
- [x] 每阶段有独立 Conventional Commit、验证命令和回滚点；staging 不包含无关文件。
- [x] 最终报告列出 commits、模块、DB migration/rollback、配置、验证、人工生产步骤和已知限制；不把本地证据描述成生产证据。

### 已知限制

- 服务端受控 query/filter/cursor 与大列表分页已实现；尚未引入 D1 FTS5 或外部全文索引。
- HTML MIME 内容会持久化但不会直接渲染；sandbox/sanitized HTML、远程图片策略与内嵌 CID 预览仍在 TODO。
- Playwright harness 与确定性凭据 fixture 已提交，但只作用于操作系统临时目录中的隔离本地 D1/R2 和 fake provider；CI 运行 Bun、check/build 与浏览器门禁。
- 已执行自动 axe/缩放/触控审计；未执行真实屏幕阅读器、真实 D1/R2/Email Routing/Resend smoke、远程 migration 或生产部署。
- 单附件与原始 `.eml` 下载已实现；附件预览、批量下载和完整 MIME 结构 UI 尚未实现。

## 8. 需要人工完成的生产步骤（实施后清单）

1. 在 Cloudflare 创建/确认 Worker、D1、R2、assets、Email Routing，并将真实资源 ID/域名写入受保护配置。
2. 使用安全渠道设置 `RESEND_API_KEY`、`RESEND_WEBHOOK_SECRET`、session/credential secret 与 `OUTBOUND_FROM_*`；执行 admin bootstrap，不把密码放进仓库或聊天。
3. 先执行并记录远程 D1 migrations 与备份/行数校验，再启用新 reader；配置 Resend webhook 指向受保护 endpoint。
4. 在专用窗口由人工执行 smoke test：外部邮箱入站、D1 单条 dedupe、R2 raw/附件、安全查看下载、UI send、submitted、delivered、bounce/suppressed、refresh 后状态、light/dark/mobile/keyboard。
5. 保留旧数据与回滚窗口；异常时按阶段提交 SHA、migration 版本和文档步骤回退，不删除原始 R2/D1 数据。

## 9. 计划自检

- [x] 已读取根目录 `AGENTS.md`，并遵守只写本计划、不提交的子任务边界。
- [x] 已读取外部规范，并将规范 §17 的 11 阶段按原顺序写入；每阶段均包含产物、验证和独立回滚点。
- [x] 已检查 `package.json`、`svelte.config.js`、`worker/index.ts`、Wrangler 配置/部署脚本、`schema.sql`、`src/lib/server/**`、`src/lib/mock/mailbox.ts`、`+page.svelte`、mail components、`app.css`、README/DEPLOY/TODO/GEMINI prompt。
- [x] 已记录 `bun install`、`bun run check`、`bun run build`、`git status --short --branch` 基线，并明确 `bun.lock` 是基线安装产生、将在依赖阶段归档的漂移。
- [x] 已提供当前 Mermaid 架构、带文件/行号证据的结构性风险、目标边界、非破坏性迁移、生产/安全边界、完成定义和人工生产步骤。
- [x] 未执行生产部署、远程迁移、真实 Resend 调用、真实 smoke test 或真实邮件发送。
