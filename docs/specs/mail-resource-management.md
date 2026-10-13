# 邮件资源表格管理 Spec

状态：设计、实现边界与验收记录；本文件区分已完成的本地实现/浏览器证据和未授权的远程证据。交付提交即包含本记录，最终 SHA 在交付消息中给出。

历史核查基线：2026-10-13，`main` / `e7fa432f658c7a307df021cd2758b1f2e7750611`。
本地工作区：`/tmp/FlareMail-mail-resource-tables`；分支 `feat/mail-resource-tables`，基线 `e7fa432`。最终交付消息记录交付提交 SHA。

## 目标和边界

Domains 与 Email addresses 是配置管理页面，首屏首先回答“已经接入了哪些资源以及当前需要处理什么”。资源表格承担身份、配置和简短状态；供应商检查、路由观察、检查时间和安全解释只在详情/诊断弹窗中按需展示。新增和编辑均由明确按钮打开 Dialog。

本次重构不改变邮件身份模型、Owner 权限、远端规则所有权、删除预检、发送就绪门禁或未知地址收集门禁。它不新增 API、D1 migration、绑定、环境变量或依赖；现有接口和服务端校验继续是权威。这里的“刷新”只读取已保存资源，显式“同步 Cloudflare 配置”才调用发现接口并说明它可能写入共享 D1 身份元数据。

## 现有操作盘点（历史基线）

以下盘点来自基线 `src/lib/components/mail/MailIdentityManager.svelte`、`MailDomainSetup.svelte`、身份 API 和 ADR 0014。目标实现必须逐项迁移，不因把入口放入菜单而丢失条件判断。

| 资源/操作 | 当前入口和实际行为 | 目标入口 |
| --- | --- | --- |
| 读取资源 | 挂载时 `GET /api/workspace/mail-identities`；当前 `load(true)` 随后自动 `POST /sync` | 首次进入和普通刷新只 GET；保留表格；请求失败显示错误而不是空配置 |
| 刷新列表 | `load()` 会重载 Domains、Addresses 并更新写信身份 options | 工具栏 Refresh；保留筛选/排序/页码上下文及已有表格 |
| 发现并导入 Cloudflare 配置 | 同步按钮或挂载流程调用 `POST /api/workspace/mail-identities/sync`；只读供应商发现，但会写本地 D1 身份元数据 | 更多操作中的显式 Sync；显示新增、部分成功、失败和重试结果 |
| 新增域名 | `MailDomainSetup` 提交 `POST /api/workspace/mail-identities/domains`，传 `domainName`、`zoneId`；服务端核验 Zone、账号和域名边界 | Domains 页主按钮 Add domain 打开相同表单 Dialog；成功后读取列表并保留上下文 |
| 编辑域名 | Domain settings Dialog；`PATCH /domains/:domainId`，支持 `enabled`、`unknownRecipientPolicy` | 每行 Actions 中的带可访问名称铅笔图标；映射字段只读；收集策略继续展示 catch-all 前提 |
| 检查域名 | Domain 行 Check status 调用 `POST /domains/:domainId/check`；结果和 Cloudflare/Resend 状态当前常驻 | 行菜单 Check status；结果进入诊断 Dialog。POST 结果不确定时先安全 GET 回读，保持未知并锁定该域名的重复检查，直到一次成功 Refresh/GET 清除锁定 |
| 域名新增地址 | 域名卡片内 quick-create form 或跳转地址完整创建表单；均调用 `POST /api/workspace/mail-identities` | Domain 行菜单 Add address；共用新增地址 Dialog，预选该域名 |
| 查看域名地址 | 基线把关联地址嵌套在 Domain card 内 | Address count / View addresses 进入 `view=addresses&domain=<id>`，真正筛选地址表格 |
| 新增地址 | Addresses 页常驻表单，传 `domainId`、`address`、可选 `displayName`/`signature` | Addresses 页主按钮或域名行菜单打开共用 Dialog；域名、前缀、完整地址预览可见 |
| 编辑地址 | 行内 Edit dialog；`PATCH /api/workspace/mail-identities/:addressId` 只改名称/签名 | 行 Actions 中的带可访问名称铅笔图标；邮箱字符串和域名归属只读；保留输入和脏表单保护 |
| 地址生命周期 | 行按钮按 active/disabled/deleted 显示 disable、enable 或 restore，调用 `POST /:addressId` | 行菜单保留相同门禁；已删除且路由已协调时可恢复，未协调时仍可重试，保留诊断/历史适用操作 |
| 路由导入/重试 | `import` 仅在 `route === importable`；`retry` 在 pending/provisioning/deleting/unknown/error 等状态可用 | 行菜单按真实状态条件显示 Import/Retry；未知结果不诱导重复创建 |
| 发信开关与默认发件人 | active 地址按 readiness 显示 enable_send、disable_send、make_default | 行菜单/次级操作保留 `mailSenderSendBlockReason` 门禁；`send_enabled` 不直接显示为 send-ready |
| 删除地址 | Delete 先 GET `/:addressId/delete-preview`，再按策略 DELETE；保留路由/移除自有路由/保留导入规则等安全门禁 | 行菜单 Delete 打开原预检 Dialog；不以普通确认替代；保留历史邮件和 catch-all 风险 |
| 写信身份联动 | 每次成功读取后调用 `onOptionsChange`，刷新域名/地址与 sendReady 派生状态 | 任何成功保存、动作、同步或刷新后继续更新 options；失败读取不清空旧表格 |

不新增域名删除、批量删除、远程 DNS/路由接管、地址重命名或独立登录账号。健康检查、真实收发和最终投递仍是不同证据层级。

## 最终页面结构和列

本节的列、菜单、Dialog、读取边界和状态文字描述当前实现契约；验证矩阵另行记录各组已完成的本地证据。

当前实现边界：`MailIdentityManager.svelte` 负责表格、筛选、排序、分页、写入编排和菜单；`MailIdentityDiagnostics.svelte` 负责按需诊断内容；`MailDomainSetup.svelte` 复用域名接入表单；`mail-resource-types.ts` 集中管理资源/检查类型；`mail-resource-list.ts` 只负责完整集合上的筛选和分页。共享 `Dialog`、`DropdownMenu`、`IconButton` 和 URL controller 只做必要的焦点、导航和弹窗支持。

### Domains

页面标题为“Domains / 域名”，可在标题旁显示资源总数。主按钮为“Add domain / 新增域名”。标题下是紧凑工具栏：按域名搜索、必要的生命周期/可用性筛选、Refresh，以及包含显式 Sync 的 More actions。首屏直接进入语义 `<table>`；无资源时显示准确空态和 Add domain，不自动展开接入表单。

桌面列固定为：

| 列 | 内容和口径 |
| --- | --- |
| Domain | 域名主标识；可打开详情，但 Edit 仍有独立可发现入口 |
| Addresses | 未删除地址数，包含 disabled；链接到已按该域名筛选的 Addresses 视图 |
| Status | Domain enabled/disabled，文字和状态标记同时存在 |
| Receiving | 简短的 ready / check needed / unavailable；只根据 `summarizeDomainCapabilities` 与现有观察，不把 enabled 当成真实收信证明 |
| Sending | 简短的 ready / check needed / unavailable；不把 domain enabled 或 `send_enabled` 当成 Resend send-ready |
| Actions | Edit、Add address 等高频入口；其余进入 More menu |

低宽度时保留 Domain、Status、Receiving/Sending 的必要文字和 Actions；检查时间、provider 错误、catch-all 目标、Worker 映射和地址细节进入详情/诊断 Dialog。不得用卡片堆叠或页面横向滚动代替表格语义。

Domains 行 More menu 的项目和条件：

| 菜单项 | 条件/结果 |
| --- | --- |
| Add address | 仅启用且满足现有创建条件的域名；打开共用新增地址 Dialog 并预选该域名 |
| Check status | 触发已有域名检查；提交中禁用重复请求，结果进入诊断/状态区域 |
| View diagnostics | 只读显示 Cloudflare/Resend 状态、检查时间、过期/下次检查、catch-all 和路由异常 |
| Sync Cloudflare configuration | 页面级 More 或工具栏入口；显式调用发现接口并显示 partial/unknown result |

Edit domain 是行 Actions 中带可访问名称的铅笔图标高频入口，不重复放入 More menu。不存在 Domain delete 菜单项。Domain/Zone/Worker 映射只读；停用影响和 collect 前提在编辑或确认动作中说明。

### Email addresses

页面标题为“Email addresses / 邮箱地址”，可显示资源总数。主按钮为“Add address / 新增邮箱地址”。工具栏提供地址或显示名称搜索、Domain 筛选、生命周期筛选和 Refresh；生命周期筛选与表格中的收发就绪状态保持不同语义，不提供含义混杂的“正常”选项。默认集合是未删除地址，包含 disabled；deleted 通过明确 Deleted 筛选访问。

桌面列固定为：

| 列 | 内容和口径 |
| --- | --- |
| Email address | 地址主标识；显示名称为次级信息；长值可换行和复制 |
| Domain | 所属域名；可作为筛选上下文 |
| Address status | active / disabled / deleted；不得和 provider readiness 混成 “Normal” |
| Receiving | receive enabled 与当前路由状态的简短语义 |
| Sending | send enabled、默认发件标记和 `mailSenderSendBlockReason` 派生结果；标记不能只靠颜色 |
| Actions | Edit 和必要的高频入口；其他动作进入 More menu |

Address 行 Actions 中的 Edit details 是带可访问名称的铅笔图标高频入口；More menu 逐项保留已有条件：Disable/Enable/Restore；Import rule（仅 importable）；Retry routing（仅可重试路由状态）；Enable/Disable sending；Set as default（仅非默认且 send-ready）；Delete（仅非 deleted，打开 delete-preview）。删除行不得暴露活跃地址的编辑、发信或普通删除动作。诊断入口可显示地址路由、最后安全错误和所属域名检查结果。

## Dialog 和状态契约

所有 Dialog 复用共享 `Dialog`、字段、状态和菜单 primitives。标题、描述、初始焦点、错误区域和按钮都必须可访问；提交中禁止重复提交，关闭入口、Esc 和遮罩遵循相同的脏表单策略。菜单卸载后焦点回到仍存在的触发器；触发器因筛选消失时回到表格标题或对应工具栏控件。

| Dialog | 打开方式 | 必须展示/行为 |
| --- | --- | --- |
| Add domain | Domains 主按钮 | `domainName`、`zoneId`；固定 Worker/账号说明；权限或绑定缺失时准确阻塞；输入错误保留；成功后刷新列表/options |
| Edit domain | Domain 行 Edit | enabled、unknown recipient policy；映射只读；collect 要求 fresh Worker catch-all；脏表单取消不静默丢失 |
| Add address | Addresses 主按钮或 Domain 行 Add address | 可选域名、地址前缀、完整地址预览、显示名称、签名；停用/不符合条件域名不可选；重复和规范化错误由服务端最终判断 |
| Edit address | Address 行 Edit | 邮箱和域名归属只读；名称/签名可编辑；不删除重建；失败保留输入 |
| Diagnostics / Check result | Domain 或 Address 行菜单 | Cloudflare/Resend 状态、检查时间/过期、catch-all、路由归属/冲突、可恢复错误和 Check/Retry；未检查和未知结果保持未知，不转绿色 |
| Delete address preview | Address 行 Delete | 先读取现有 delete-preview；展示 route/catch-all/新鲜度/历史保留和策略；仅当原门禁允许时启用确认；远端写入不由普通确认替代 |
| Sync result | 页面 More / Sync | 明确这是发现并导入符合条件本地配置的写入操作；显示新增、跳过、partial、失败和可重试结果；不把请求超时直接说成未写入 |

公共状态：首次加载使用表格骨架；刷新时保留已有行；GET 失败保留旧行并显示错误；写入成功但刷新失败显示“已保存，刷新失败”，不能诱导重复创建；POST 超时、5xx、409 或会话变化后先用安全 GET 核对资源：找到新资源时显示“已找到记录，原请求结果仍不确定”，找不到且 GET 成功时显示“未找到匹配记录，原请求结果仍不确定”，保留警告并允许用户核对后明确重试，GET 也失败时保留输入并显示未知结果。仅当错误码属于已知可能在地址写入后抛出的 409 错误 `CLOUDFLARE_ROUTING_CONFLICT`、`MAIL_ADDRESS_OPERATION_CONFLICT` 或 `MAIL_DOMAIN_DISABLED`，且安全 GET 找到与提交规范化元数据匹配、`receive_enabled !== 1` 的地址时，才显示已保存但需处理/待确认状态；`MAIL_ADDRESS_ALREADY_EXISTS` 与 `MAIL_ADDRESS_RESTORE_REQUIRED` 在创建表单中显示确定性的已有记录/本次请求未创建新地址文案并冻结草稿，诊断仍按存储的 `routing_state` 展示，若该状态为 unknown 仍保持 unknown。未知 5xx 找到地址时保留草稿。创建请求用不可变的 `createAttempt` 记录目标，即使读取期间域名被停用也不改写原提交目标。域名 Check status 的 POST 结果不确定时同样先 GET 回读；在一次成功 Refresh/GET 重新建立可信状态前，保持该域名的 Check/Retry 入口锁定。请求竞态不得覆盖后来的筛选、导航或编辑目标。会话过期保留表单内容并进入既有重新认证流程，重新认证不自动重放写请求。

## URL、读取和同步边界

继续使用 `folder=settings&view=domains|addresses`。Addresses 的 `domain` 参数仅代表合法的列表筛选/新增预选上下文，绝不因 URL 自动打开 Dialog；无效或已失效域名上下文需安全清除或显示明确无结果。管理页搜索和筛选不复用邮箱工作区的 `q`、identity 或 folder 语义。

首屏、切换视图和普通 Refresh 只执行 `GET /api/workspace/mail-identities`。`POST /api/workspace/mail-identities/sync` 只由用户显式选择 Sync 调用；它会发现已配置 Cloudflare Zone/规则并写入本地身份元数据，不能接管或修改远端路由。同步 POST 的失败/超时同样先安全 GET 核对现有资源，再决定显示已找到、未知或可重试结果。健康 Check 仍调用已有域名检查接口，不因查看详情自动执行路由变更。

分页页脚显示当前筛选条件下的完整匹配数与默认资源集合总数；它不把当前 25 行页面数当成匹配总数。例如筛选后有 30 个地址、当前页 25 行，应显示 30 个匹配资源并显示第 1 / 2 页。

## 要求与证据清单

证据必须来自实现分支当前提交。以下“静态代码已核对”只表示已阅读当前实现，不替代测试或浏览器证据；历史 `docs/UI_UE_REVIEW.md` 中的旧提交和截图只能证明当时状态，不能代替当前 HEAD 的验证。

| 要求 | 权威证据 | 状态 |
| --- | --- | --- |
| 两页首屏先显示资源表格 | 当前 `MailIdentityManager.svelte` + 匹配的 Chromium 桌面套件 | 表格首屏与只读加载用例通过；准确运行计数见下方矩阵 |
| Add domain/Add address 通过明确入口打开 Dialog | 当前组件 + 桌面交互用例 | 对应跨浏览器管理用例通过 |
| 编辑、诊断和删除预检按需打开 | 当前组件 + Dialog focus/dirty/error 回归 | 对应跨浏览器管理用例通过 |
| 无常驻创建表单、行内 quick form、诊断面板 | 当前组件 + 空态/首屏截图 | 对应跨浏览器管理用例通过；截图在 `/tmp/flaremail-management-evidence/` |
| 首次进入和普通刷新不 POST `/sync` | `onMount load()` 与网络断言/request spy | 对应跨浏览器管理用例通过 |
| 显式同步的结果和写入边界可见 | `syncResources()` + Sync 交互用例 | 对应跨浏览器管理用例通过；部分成功截图已留存 |
| 域名地址数包含未删除 disabled 且范围正确 | `domainAddresses()` 派生逻辑 + 筛选测试/截图 | 单元测试计入 633 项通过；对应跨浏览器管理用例通过 |
| 地址 domain 深链真正筛选列表 | URL controller + 浏览器前进/后退/清除筛选 | URL controller 单元与浏览器导航用例通过；失效上下文显示清除 CTA |
| send readiness、route state 和 health freshness 不混淆 | `mailHealthState`、`mailSenderSendBlockReason`、`summarizeDomainCapabilities` 使用及边界测试 | 单元测试 633 项通过；对应跨浏览器管理用例通过 |
| 现有创建、编辑、启停、发信、默认、导入、恢复、重试、删除门禁无遗漏 | API 入口盘点 + 行菜单条件测试 | 单元测试与 对应跨浏览器管理用例通过 |
| 部分成功、未知结果、刷新失败保留资源身份 | 安全 GET reconcile、`addressFoundAfterUnknown`、定向错误/竞态测试和截图 | 所有 POST 409 场景均先安全 GET 回读；仅已知可能在地址写入后抛出的 `CLOUDFLARE_ROUTING_CONFLICT`、`MAIL_ADDRESS_OPERATION_CONFLICT`、`MAIL_DOMAIN_DISABLED` 可在匹配提交规范化元数据且 `receive_enabled !== 1` 时进入 SavedNeedsAttention；`MAIL_ADDRESS_ALREADY_EXISTS`/`MAIL_ADDRESS_RESTORE_REQUIRED` 在创建表单显示确定性的已有记录/本次请求未创建新地址文案并冻结草稿，诊断仍按存储 `routing_state` 展示；未知 5xx 找到记录时保留草稿；不可变 `createAttempt` 保留停用前的提交目标；部分成功截图已留存 |
| Check status 不确定结果不会诱导重复检查 | Check POST 后安全 GET 回读、未知状态和成功 Refresh/GET 解锁 | 对应跨浏览器管理用例通过 |
| API、D1、环境变量、依赖无变化 | 最终 HEAD 的 `git diff`、迁移目录、绑定配置和 `package.json` 审查 | Git 差异已核对，无 API/server、D1、环境变量或依赖变化 |
| 中文/英文、浅色/深色、桌面布局与键盘可用 | 匹配 Playwright 浏览器矩阵、单元/a11y 证据和截图 | 当前管理测试总数 23；Chromium 桌面初始匹配 28 项及 affected 定向 9 项通过；匹配移动初跑为 22 个新增加 9 个相关既有用例，29 项通过、2 项跳过，发生在最新 duplicate-409 guard 前；随后移动 affected 定向 6 项通过。窄屏初跑 20 项通过后 SIGTERM 143，补跑 4 项中 3 项通过、1 项跳过；Firefox 146 最终匹配 25 项中 24 项通过、1 项跳过；WebKit iPhone 26 项中 25 项通过、1 项跳过；WebKit iPad 26 项中 25 项通过、1 项跳过；WebKit 桌面初始匹配 22 项通过、1 项跳过，affected 定向 7 项通过 |
| PRE、生产、真实供应商行为 | 授权记录、部署/运行时证据 | 本轮未授权，未验证 |

## 最终交付证据

以下记录来自匹配当前 Playwright 1.58.2 的官方浏览器二进制和本地隔离验证。不同项目缓存中的浏览器结果没有纳入本矩阵。交付提交即包含本记录的提交，最终 SHA 在交付消息中给出。

### 实际变更边界（23 个路径）

资源表格和动作编排集中在 `MailIdentityManager.svelte`；诊断、资源类型和过滤/分页分别由独立模块承载，排序也保留在管理器中，已移除未使用的通用排序 helper。共享 `Dialog`、`DropdownMenu`、页面 URL/controller、测试配置、i18n 和文档是同一交付范围的一部分：

```text
DESIGN.md
docs/API.md
docs/PREVIEW.md
docs/UI_UE_REVIEW.md
docs/USER_GUIDE.md
docs/specs/mail-resource-management.md
playwright.config.ts
src/lib/client/mail-resource-list.test.ts
src/lib/client/mail-resource-list.ts
src/lib/client/workspace-url-controller.test.ts
src/lib/client/workspace-url-controller.ts
src/lib/components/mail/MailDomainSetup.svelte
src/lib/components/mail/MailIdentityDiagnostics.svelte
src/lib/components/mail/MailIdentityManager.svelte
src/lib/components/mail/mail-resource-types.ts
src/lib/components/ui/Dialog.svelte
src/lib/components/ui/DropdownMenu.svelte
src/lib/i18n/messages.ts
src/routes/+page.svelte
tests/e2e/firefox-smoke.spec.ts
tests/e2e/mail-management.spec.ts
tests/e2e/webkit-smoke.spec.ts
tests/e2e/workspace.spec.ts
```

### API、数据库、环境和依赖边界

最终差异核对确认没有 API/server、D1 schema/migration、Cloudflare 环境/绑定或依赖变化。`src/routes/api/workspace/mail-identities/`、相关 `src/lib/server/mail-identities/`、`migrations/`、`schema.sql`、配置文件、`package.json` 和 `bun.lock` 均不在这次变更范围内。

### 本地命令和行为证据

- 新鲜单元/客户端/服务端相关测试日志 [`/tmp/flaremail-management-final-unit.log`](/tmp/flaremail-management-final-unit.log)：633 项通过、0 项失败，3,924 个期望，111 个文件，15.81 秒。缓存自其他项目的浏览器结果未计入。
- 最终冻结 UI 的 `check` 为 0 errors / 0 warnings，`build` 通过；日志分别为 [`/tmp/flaremail-management-final-check.log`](/tmp/flaremail-management-final-check.log) 和 [`/tmp/flaremail-management-final-build.log`](/tmp/flaremail-management-final-build.log)。malformed syntax URL 的 `queueMicrotask` 清除修复已包含在该结果中。
- 初始交付管理测试总数为 23；匹配移动初跑发生在最新 duplicate-409 guard 之前，22 个新增用例加 9 个相关既有用例共 29 项通过、2 项跳过，日志为 [`/tmp/flaremail-management-final-mobile.log`](/tmp/flaremail-management-final-mobile.log)，后续 affected 定向 6 项通过，日志为 [`/tmp/flaremail-management-final-mobile-targeted.log`](/tmp/flaremail-management-final-mobile-targeted.log)。窄屏初跑 20 项通过后收到外部 SIGTERM 143；没有断言失败；随后 4 项定向补跑 3 项通过、1 项因 desktop-only capture 跳过，日志为 [`/tmp/flaremail-management-final-narrow-completion.log`](/tmp/flaremail-management-final-narrow-completion.log)，与初跑合计覆盖 22 个适用的新管理用例。
- Playwright 版本为 1.58.2，官方二进制为 Chromium 1208（145）、Firefox 1509（146）、WebKit 2248（26）。Firefox 最终匹配 25 项中 24 项通过、1 项跳过（23 项新增含 desktop-only capture、2 项相关既有），用时约 2.7 分钟，日志为 [`/tmp/flaremail-management-final-firefox.log`](/tmp/flaremail-management-final-firefox.log)。driver emulate 的 COOP same-origin 初始失败仅作来源记录，不计入最终结果；原生 Firefox preference 0/dark 在 reload 前后同时得到 media 与 `html` dark，产品 headers 未改动，既有动态 dark/light 应用路径和 root Shift+Tab 均通过。证据记录在 [`/tmp/ff-media-coop-findings.txt`](/tmp/ff-media-coop-findings.txt) 和 [`/tmp/ff-media-pref-labels.json`](/tmp/ff-media-pref-labels.json)。
- WebKit iPhone 26 项中 25 项通过、1 项跳过（日志：`/tmp/flaremail-management-final-webkit-iphone.log`）；iPad 26 项中 25 项通过、1 项跳过、3.9 分钟（日志：`/tmp/flaremail-management-final-webkit-ipad.log`）。WebKit 桌面初始匹配 22 项通过、1 项跳过；affected 定向重跑 7 项通过，日志为 [`/tmp/flaremail-management-final-webkit-desktop-targeted-retry.log`](/tmp/flaremail-management-final-webkit-desktop-targeted-retry.log)；先前 SIGTERM 143 的运行排除在最终结果外。其余矩阵使用现有 `start-local` 脚本的临时副本，仅调整路径；在每个项目新的 D1/R2 状态上执行，确认单次 frozen build 后省略重复 build。临时 harness 没有依赖或配置提交变化，现有 `testMatch` 变更除外。PRE、生产和真实供应商行为本轮未授权，未验证。

### 当前浏览器矩阵（按实际运行分组记录）

| 运行 | 初始或基础运行 | 附加定向运行 |
| --- | --- | --- |
| Chromium 桌面 | 初始匹配 28 项通过 | 受影响目标 9 项通过 |
| Chromium 移动 | 初始匹配 29 项通过、2 项跳过（22 项新增、9 项相关既有） | affected 定向 6 项通过 |
| Chromium 窄屏 | 中断初跑 20 项通过、SIGTERM 143，无断言失败 | 补跑 4 项（3 项通过、1 项跳过），日志 `/tmp/flaremail-management-final-narrow-completion.log` |
| WebKit 桌面 | 初始匹配 22 项通过、1 项跳过 | affected 定向 7 项通过（domain context、3 conflicts、duplicate、pending、long） |
| Firefox | 25 项中 24 项通过、1 项跳过 | 无附加定向运行 |
| WebKit iPhone | 26 项中 25 项通过、1 项跳过 | 无附加定向运行 |
| WebKit iPad | 26 项中 25 项通过、1 项跳过（3.9 分钟） | 无附加定向运行 |

证据边界：native Firefox preferences 只用于绕过 driver emulate 的 COOP 问题，未改产品 headers；Linux WebKit 设备模拟不等于实体 Safari；390×360 短视口只模拟键盘布局，不等于真实操作系统键盘；CSS zoom 2 只模拟 200% 缩放，不等于手动浏览器缩放。证据目录 `/tmp/flaremail-management-evidence/` 已留存 18 个截图文件，包括桌面、移动、窄屏、长内容、Add domain、Add address、Domain settings、Edit address、Diagnostics 和 partial-success 场景。

页面和路径证据覆盖 `folder=settings&view=domains`、`folder=settings&view=addresses` 及 `folder=settings&view=addresses&domain=<合法 domain id>`。无效或失效的合法 ID 上下文显示清除 CTA，文案明确说明当前筛选没有可用域名；malformed syntax URL 在接受导航后由 `queueMicrotask` 移除。截图和临时浏览器状态位于 `/tmp/flaremail-management-evidence/`，包含 2 张桌面截图、2 张移动截图，以及 Add domain、Add address、Domain settings、Edit address、Diagnostics、partial-success 和长内容场景截图。

行为证据还覆盖：所有 POST 409 场景均先安全 GET 回读；只有已知可能在地址写入后抛出的 `CLOUDFLARE_ROUTING_CONFLICT`、`MAIL_ADDRESS_OPERATION_CONFLICT`、`MAIL_DOMAIN_DISABLED` 才能在匹配提交规范化元数据且 `receive_enabled !== 1` 时进入 SavedNeedsAttention/pending。`MAIL_ADDRESS_ALREADY_EXISTS` 和 `MAIL_ADDRESS_RESTORE_REQUIRED` 在创建表单显示确定性的已有记录/本次请求未创建新地址文案并冻结草稿，诊断仍按存储的 `routing_state` 展示，若为 unknown 则保持 unknown；未知 5xx 找到地址时保留草稿；不可变 `createAttempt` 在域名读取期间被停用时仍保留原提交目标；最终共享 Dialog 修复让 focusable controls 重新出现时从 dialog root 的 Shift+Tab 仍留在弹窗内，断言加入既有 pending-save 用例，测试总数仍为 23；过滤、计数、分页 helper 的结果与表格页脚一致。

本地实现与浏览器矩阵均已按实际运行分组记录；交付提交 SHA 在交付消息中给出。所有浏览器结果均为本地隔离环境证据，不代表真实 Safari、生产或真实邮件投递。

## 已使用的新增文案 key

实现已使用以下新增 `settings.*` key；中英文值位于 [`src/lib/i18n/messages.ts`](../../src/lib/i18n/messages.ts)。其余标题、操作、状态和诊断文案复用既有 key，`settings.diagnostics` 也保持复用。新增 key 仅覆盖表格搜索/筛选/分页、弹窗脏状态、同步说明和未知写入结果：

`activeAddresses`, `addressAlreadyExistsReadback`, `addressCountHelp`, `addressFoundAfterUnknown`, `addressPrefixInvalid`, `addressPreview`, `addressSearch`, `allDomains`, `allStates`, `clearFilters`, `configuredAddresses`, `deletedAddresses`, `disabledAddresses`, `discardChanges`, `discardChangesDescription`, `discardChangesTitle`, `domainFilter`, `domainSearch`, `filteredCount`, `invalidDomainContext`, `keepEditing`, `loadFailedRetry`, `moreActions`, `needsCheckDetails`, `nextPage`, `noAvailableDomains`, `noMatches`, `optionalAddressSettings`, `previousPage`, `refreshFailedKept`, `refreshList`, `resourceActions`, `resourceOutsideFilter`, `resourcePage`, `resourceStatus`, `savedRefreshFailed`, `sortAscending`, `sortDescending`, `stateFilter`, `syncImportConfirm`, `syncImportExplanation`, `verifyWriteOutcome`, `viewAddresses`, `writeOutcomeUnknown`, `writeVerifiedMissing`。

## PR 审查后的焦点回归修复

PR #10 的 Code Review 发现：共享 DropdownMenu 在已有 ReaderDialog 内关闭时，因页面仍有 Dialog 而跳过焦点恢复。修复区分菜单所属的已有 Dialog 和本次操作新打开的 Dialog：Escape 或不打开新弹层的菜单动作关闭后，焦点回到原菜单按钮；新弹层仍接管焦点。

独立的 `restores ReaderDialog focus after its menu closes` 浏览器用例覆盖这两个关闭路径；既有阅读工作区用例也补充同样的断言。该新增用例不计入上方初始交付的 23 项管理测试矩阵，修复提交的运行结果另记录在 PR 验收证据中。

后续审查还补充两条边界：未修改且未提交中的管理弹窗在 Back/Forward 时关闭并接受当前导航，只有脏表单确认才使用延迟继续回调；成功读取资源后丢弃旧检查缓存，本次 POST 的各供应商结果仅在其自身检查时间与 GET 快照相同时独立保留。Resend 未配置或状态更新不能丢弃仍有效的 Cloudflare 路由观察。对应回归覆盖单次历史遍历、错误检查后读取到恢复状态的诊断显示，以及仅配置 Cloudflare 时导入刚发现的规则。

删除失败或仍在协调中的 tombstone 在行菜单和诊断弹窗保留 Retry；仅在服务器允许的已协调路由状态显示 Restore。provisioning 和安全错误标记也保留重试。当前环境未配置 Resend 时，历史健康记录不将发信或默认发件人操作显示为可用；已确认的供应商检查清空错误后，刷新失败也不能回退显示旧错误。

## 兼容性结论

本设计只改变管理页面的信息架构和客户端入口。API 路径与 payload、D1 schema/migrations、Cloudflare/Resend 环境变量和 `package.json` 依赖均应保持不变。若实现发现必须扩大到 API 或契约，须在实现提交前补充缺口、兼容性、迁移和测试说明；不能在文档中把推测写成完成事实。
