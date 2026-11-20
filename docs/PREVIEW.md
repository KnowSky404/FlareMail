# 使用全局 cf 验收 PRE

使用全局 `cf` 和原生 `cloudflare.config.ts`。本地构建使用 `cf 1.0.0-rc.1` 与锁定的 Vite 插件 `2.0.0-rc.0`，要求 Node.js ≥ 22.18。旧配置和命令见[历史记录](archive/wrangler-preview.md)。

当前 `mail-ai` 使用独立 D1 和 R2。独立 PRE 收信 Worker 已撤下，Cloudflare 禁用了关联的精确规则。旧测试地址仍可能命中生产 catch-all。首次切换的前置检查、规则恢复、停收探测和入箱验收按 [单 Worker 的 PRE 真实收信 SPEC](specs/single-worker-pre-inbound.md) 的完整顺序执行。

## 默认验收顺序

1. 在独立 worktree 从最新 `origin/main` 开发，完成 `bun run test`、`bun run check`、`bun run build`、相关浏览器 QA、`bun run deploy:dry-run`，创建干净原子提交。
2. 仅在已获 Preview 授权时，填写忽略的 `cloudflare.preview.json`（模板 `cloudflare.preview.json.example`），权限 `0600`。使用现有生产 Worker 名称作为原生 Preview 的父级，沿用 `mail-ai` 的独立 D1 和 R2。发布前核对 PRE 的 D1 UUID 和 R2 桶名分别与生产不同。设置 `APP_ENV=preview`、实际 Provider/Auth 配置，关闭自动回复、通知和 Telegram，使用 `cron=[]`。资源创建、Owner 初始化和邮件规则调整各自独立授权。
   在发布之前检查 Previews Base、现有 Preview secrets 与候选目标的合并结果。当前方案尚未实施时，确认将生成的部署既不继承 Cloudflare 路由读取或写入权限，也没有可用于全量发现的身份配置。无法确认就停止发布，先按下文「当前 mail-ai 的邮箱身份验收」核对旧配置及权限。
   如果沿用 PRE D1 并更换 R2，在部署前先于授权维护窗口暂停并排空所有访问 PRE D1/R2 的入口和任务，包括只读入口和旧预览 URL。再清点原信、独立正文、草稿、附件和待处理记录依赖的对象，核对新桶上的对象和完整性。没有相关对象时记录空清单。涉及复制、修复或删除时取得相应授权。
3. `bun run deploy:pre -- --preview-name mail-ai` 先构建 Svelte 应用，再在 `worker/` 通过全局 `cf previews deploy --mode preview` 构建并上传原生 Preview，不切换生产流量。使用合法稳定的名称。记录命令时间、提交 SHA、Preview URL 和部署/版本 ID。
4. 上传后先按下文「当前 mail-ai 的邮箱身份验收」检查 Cloudflare 实际绑定、规则权限、仍可访问的旧 URL 和生产 deployment。隔离核对通过后，才验收登录、业务页面/API 和已认证 `/api/readiness`。`/api/health` 仅证明存活，HTTP 验收和 `email()`、Cron、真实投递各自需要证据。
   更换 R2 后，在恢复常规访问前，用授权的验收入口和已读样本核对原文、正文与附件可读取，并验证所有将恢复的入口使用核定存储。
5. **当前 D1 和 R2 独立，默认只读**。E2E seed、fixture、Owner bootstrap、数据库重置和迁移与默认验收分开。打开未读邮件会自动写入已读状态，使用已经读过的消息和只读 HTML/CID GET 接口进行预览验收。真实邮件、Telegram、数据写入及路由/DNS 修改必须在明确授权范围内。
   域名页新增“刷新全部”，并在页面空闲时每分钟重读状态、每五分钟复查供应商
   配置。供应商请求只读，但 `/domains/:domainId/refresh` 和完整检查会写入
   当前 PRE D1 的检查元数据。默认只读验收应直接使用 GET 接口；浏览器验收若
   允许这些检查请求，须先获得域名/地址检查状态写入授权，不能视为纯只读访问。
6. PRE 业务验收完成后，分别在 push 和创建 PR 前实际执行 `codex review --base origin/main` 并处理有效问题。等待当前 head 的 Codex Code Review 和 Security Review 完成，再按仓库默认授权 rebase 合并和收尾。实现提交追加后补做受影响本地/PRE 验收及两种 review。

### 共享归属的只读 PRE 验收

候选目标绑定当前 `mail-ai` 的独立邮件 D1/R2 和已回填的专用归属 D1。Previews Base 和将发布的有效配置需确认没有邮件规则管理凭证。使用权限为 `0600` 的私有 JSON 记录本次控制面检查，路径通过 `FLAREMAIL_INBOUND_PREVIEW_PREFLIGHT` 提供。记录 `checkedAt`、`accountId`、`workerName`、`previewName`、`targetHash`、`routingDatabaseId`，以及 `production` 和 `preview` 的 `deploymentId`、`databaseId` 和 `bucket`。实际核对归属表和 Base 后，分别记录 `registryVerified` 和 `previewBaseVerified` 为 `true`。`targetHash` 是解析后的完整候选目标用 `JSON.stringify` 序列化后的 SHA-256。上传前重新核对线上部署，两侧证据发生变化则更新预检。`CLOUDFLARE_ACCOUNT_ID` 须与私有记录中的账号一致。

同时核对全部活动生产版本是否已有 PRE 入站绑定。无绑定时将 `production.previewDelivery` 设为 `null`。存在绑定时记录它的 `databaseId`、`bucket` 和 `routingDatabaseId`。若活动生产仍使用固定地址且未部署归属库，明确将 `routingDatabaseId` 设为 `null`，同时核对保留地址和两项 PRE 邮件存储绑定。共享模式下三项绑定均须与候选 PRE 一致。远程 PRE 需要明确设置 `CLOUDFLARE_ACCOUNT_ID`。省略共享归属的旧目标也会查询该账号的活动生产版本，在已有 PRE 收信保护时拒绝上传。

记录中填写干净工作树的完整 `previewCommit`，目标的 `APP_VERSION` 使用 `preview+<短 SHA>`。构建会核对源码与活动生产绑定。保留旧固定收件地址时，先比对生产和 PRE 的私有候选配置及已发布绑定。记录规范化地址的小写 SHA-256 为 `fixedReservationHash`，活动生产配送的相同指纹放在 `production.previewDelivery.fixedReservationHash`。

共享生产收信已配置但原生 `mail-ai` 缺失时，可用同一命令补发只读 PRE。预检记录显式设置 `preview.deploymentId: null`，沿用活动生产配置中的 PRE D1/R2、归属库及保留地址。发布程序实时确认该 Preview 缺失、归属表可查询，以及 Previews Base 未提供邮件存储、归属或收信绑定和邮件规则管理凭证。已有 `mail-ai` 时使用它的实际部署 ID。补发后核对实际部署与 Owner 就绪状态。

从可写 PRE 回到只读模式时，先核对并关闭旧可写部署及其专属 URL，再按缺失 Preview 的恢复流程发布。将 `mail-ai` 的稳定 URL 指到新版本仍会留下历史部署 URL，旧版本可能继续使用已有的写凭证。

该阶段只发布 `mail-ai`，以 Owner 会话访问只读域名、邮箱和 `/api/readiness`。就绪响应包含 `inboundRouting.environment=preview` 和 `inboundRouting.readOnly=true`。部署后重新核对 PRE 实际绑定和生产部署指针。预约的 SMTP 验收和生产规则切换按共享收信 SPEC 的后续环节执行。

单 Worker 收信方案启用后，PRE 的 D1 迁移与 D1/R2 换绑须同时检查生产 `email()`、目标 PRE 版本和所有可访问该存储的入口，包括稳定 PRE URL、部署专属 URL 和版本预览 URL。线上迁移要求所有相关版本兼容前后 schema；不兼容时先发布兼容版本，或按授权暂停并排空受影响的请求。换绑也需暂停、排空并核对两侧绑定和已有数据。逐个重新核验实际绑定与 schema 后才恢复本次维护涉及的入口。此要求适用于下文各项 PRE 迁移。参见 [单 Worker 的 PRE 真实收信 SPEC](specs/single-worker-pre-inbound.md)。

生产建立保留地址后，普通 PRE 发布须在上传前检查生产部署完整版本清单，只接受一个占 100% 流量的活动版本，并比较候选地址及 D1/R2 与其 PRE 入站配置。发布后再核对实际生效值。经授权的暂停换绑窗口按 SPEC 执行。

原生 Preview 不继承生产 secrets；新 Preview 从 Previews Base 获取 secrets。仅在 JSON 中声明 secret 名称不会复制其值，发布成功也不能证明密钥齐全。检查已安装 cf 帮助、Base 和实际部署绑定；不要为了缺少配置改用生产 `cf deploy`，也不要为验收重置密钥。

生产尚未建立 PRE 收信保护、且需要复用生产既有 secrets 时，可使用已有且获准的独立测试 D1/R2 上传版本供 HTTP 验收。两项资源都须与生产和 `mail-ai` 的存储不同，缺少该测试目标时使用原生 PRE。为版本预览准备仓库外的私有目标，用 `FLAREMAIL_CF_CONFIG` 传入，保留 `APP_ENV=preview`，关闭自动动作和 Cron。目标省略邮件路由 Worker、账号和 Cloudflare 路由 Token，隔离测试数据的本地编辑另行授权。先运行 `bun run build:app`，再在 `worker/` 使用全局 `cf workers versions create --mode preview --preview-alias <alias>`。上传前核对已安装命令帮助、独立存储、实际将继承的 secrets 和版本域名，确认远端规则能力关闭。上传后复核实际存储、权限和生产 deployment 指针，通过后才访问预览 URL。仍使用旧存储的历史 URL 纳入对应环境的权限与存储清点。

生产建立 PRE 收信保护后，旧版本 URL 须保持关闭，原生 `mail-ai` 继续承担 HTTP 验收。需要版本 URL 的独立测试应使用另外获准的 Worker。私有目标只声明已有且验收所需 secrets，路由验收继续使用授权的只读查询。

本地隔离替代验证使用 `bun run preview`（全局 `cf dev`）及 `.cloudflare/state`。Owner 明确委托验收时，按[共享收信 SPEC](specs/shared-inbound-routing.md#兼容切换)记录实际绑定、HTTP 和自动化业务验证。其他情况下，环境缺少 Owner 登录方式、PRE 配置或运行权限时，保留本地提交/worktree 并说明阻塞；不得把构建、上传或健康检查记为 PRE 验收通过，也不得提前提功能 PR。

## Keep one current PRE

Reuse the stable native Preview name `mail-ai` at
`https://mail-ai.preview.ziteng.li/`. The custom base `preview.ziteng.li` serves
Preview traffic only. The existing `mail-ai-flaremail.littlecontrol.workers.dev`
address is available while the parent Worker's `workers.dev` Preview URLs are enabled.
Before disabling them for production cutover, check TLS and authenticated readiness
on the custom address. Keep one latest usable PRE. After checking its availability,
remove other confirmed native Previews.
The user has authorized this Preview cleanup as the default. Verify the parent
Worker and Preview IDs, run `cf previews delete <id> --worker <parent> --dry-run`,
then use `--force` only to skip the confirmation for that verified Preview.
Do not use `--delete-with-references`; stop and report references that prevent
safe deletion. Never delete the parent production Worker, existing D1/R2 or
production/recovery versions as part of Preview cleanup. Version preview URLs
are not separate native Preview environments.

The installed cf CLI may expose native Preview deploy/delete without a list
subcommand. Its `builds previews list` lists Workers Builds records and is not
the native Preview inventory. Use the authenticated native Preview collection
API when necessary; never infer that zero Builds records means there are no
native Previews. Keep auth values out of output and preserve the current PRE
until a usable replacement is confirmed.

The shared-inbound release checks reuse the credential store selected by `cf`,
including the system keyring. For native Preview reads missing from the command
surface, they use the authenticated read transport bundled with the pinned
`cf 1.0.0-rc.1`. Check this integration before upgrading the CLI. An authorized,
scoped `CLOUDFLARE_API_TOKEN` in the process environment also works.

## 邮件阅读页验收

使用已读且属于当前 Owner 的邮件，检查普通阅读栏、专注阅读和独立阅读页。分段控件切换
纯文本和安全 HTML，「显示选项」管理当前邮件的 HTTPS 图片。工具栏信息图标支持悬停、
键盘和触屏查看模式说明。邮件来源、联系人、标签与技术详情从顶部紧凑入口展开，
弹层关闭后焦点返回入口，不应压缩固定头部下方的正文可用高度。

安全 HTML 的只读 GET 默认阻止远程图片，旧 `remote=1` 参数也不能开启加载。
只有 `mode=unsafe` 允许 HTTPS 图片；切换邮件后恢复默认模式。两种 HTML 模式
仍清洗内容并阻止脚本、表单、框架及 CSS 资源请求。远程图片验收会向发件人控制的
图片服务器发出请求，按本次授权范围选择邮件及是否启用不安全 HTML；合成图片请求、
恶意内容和跨浏览器回归先在隔离本地 fixture 完成，不向 PRE 写入测试数据。

## 当前 `mail-ai` 的邮箱身份验收

当前 `mail-ai` 使用已保存的身份记录进行网页验收。全量「同步 Cloudflare 配置」会把读取 Token 可见、指向配置 Worker 的规则导入 PRE D1。共用入站方案完成前，当前 PRE 不执行全量同步，模板省略 `MAIL_IDENTITY_WORKER_NAME`。原生 PRE 的父级 Worker 名称继续由目标文件中的 `name` 指定。

沿用旧私有配置时，先在独立授权的 PRE 发布中移除旧的 `MAIL_IDENTITY_WORKER_NAME`、`MAIL_IDENTITY_ACCOUNT_ID` 和 Cloudflare 规则读取、管理 Token 绑定。对照实际部署与 Previews Base，逐个核对稳定 URL、部署专属 URL 和版本预览 URL 的 D1、R2 和邮件规则能力。仍绑定生产存储的入口按 PRE 授权关闭。仍能读取或更改远端规则的入口关闭，或撤销确认只属于 PRE 的旧权限并重新核对。共享生产权限的处理另行授权。每个继续可访问的 PRE 入口须通过存储隔离和权限核对，对已授权的 Owner 会话使用只读 GET 检查保存的邮箱及域名。

验收范围包括已保存的域名、地址和本地路由状态。GET 返回上次保存的状态，当前记录也可能仍指向已删除的 Worker。实际 Cloudflare 规则需另用有授权的只读查询核对，真实入箱将按新方案单独验证。当前 PRE 模板省略 Cloudflare 路由 Token。名称、签名等本地设置的写入另行授权。全量发现、接入新域名、创建地址、恢复或删除远端规则属于下节的独立路由环境。

## 独立路由环境的邮箱身份接入

下列流程适用于拥有独占邮件路由目标的环境。当前 `mail-ai` 的验收使用上一节。

获准写入身份记录后，管理员可配置 `MAIL_IDENTITY_WORKER_NAME` 和
`MAIL_IDENTITY_ACCOUNT_ID`，并添加限于目标邮件 Zone 的 Cloudflare Token：

- `CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN`：Zone Read、Email Routing Rules Read。
- `CLOUDFLARE_EMAIL_ROUTING_TOKEN`：创建/删除规则需要 Email Routing Rules Edit。
  若不提供单独读取 Token，管理 Token 还需包含 Zone Read 和规则读取权限。
- `RESEND_API_KEY`：发信与域名发信状态检查使用生产 Resend 账号所需的 Key。

在 Cloudflare Dashboard 的对应 Preview 中配置和核对所需 secret 名称。当前全局 cf 的 Preview secret 能力以已安装帮助为准，不把父 Worker 的 secret 写入命令用于 Preview。Token 不写入 JSON target、命令参数或版本控制；密钥文件保持 `0600`，不要输出值。重新部署后检查实际绑定和读取能力。

进入“域名”或“邮箱地址”时，页面只读取本地配置，首屏显示已保存资源表格。
用户选择“同步 Cloudflare 配置”后，页面才通过已登录的
`POST /api/workspace/mail-identities/sync` 发现 Token 可访问的本账号 Zone。
同步识别指向配置收信 Worker 的精确邮箱规则及 catch-all，导入对应域名与地址；
无需手动填写已有配置的 Zone ID。同步是显式的导入操作，不等同于刷新列表。
属于其他 Worker、转发目标、重复或无效的规则不会导入，catch-all 不会虚构邮箱地址。
Cloudflare 接口只执行读取，不创建/修改/删除路由或 DNS。导入的规则标记为
`imported`，不取得规则删除权限，也不会自动启用发信。重复同步保留已有名称、
签名、启停、删除及操作状态，不恢复已删除地址。同步失败时仍展示本地配置和重试提示。
新接入且确认指向本应用的 catch-all 域名初始采用未知地址收集；既有域名的
未知地址策略保持不变。同步写入当前目标 D1 的身份记录。若两个目标共享 D1，则双方可见。

本地配置可见不等于本次 Cloudflare 同步成功。同步错误区分 Token 权限、连接失败、
超时和限流；接口只返回安全的 `details.reason`，不暴露 Token 或原始供应商响应。
发布时除登录页和健康接口外，还应在 Workers 运行时核验真实 Zone/规则读取，
避免仅在 Bun 中验证通过而漏过平台调用差异。

“手动接入其他域名”用于尚未发现的配置；其中“添加邮件域名”核验域名及所属 Zone，不自动修改 MX/SPF/DKIM 等 DNS。
接入后检查域名状态，再从新增地址弹窗创建邮箱地址。缺少 Token 或部署映射时，
页面会显示配置提示；已有域名/地址的本地设置仍可以编辑。域名设置可启停域名及
切换未知地址策略，地址可编辑名称和签名。启停、删除、恢复和发信按各自能力状态显示，涉及远端规则写入时需要管理权限。
刷新失败时保留仍可查看的本地资源，不把读取失败显示成尚未配置。

Email Routing 和 Cron 触发 Worker 的生产 handler。原生 Preview 的 HTTP 验收覆盖
网页和 API，`email()` 和 `scheduled()` 使用独立的验收路径。有真实收信需求时
参考 [单 Worker 的 PRE 真实收信 SPEC](specs/single-worker-pre-inbound.md)。
应用长期管理凭据使用限于目标 Zone 的 Token。

参考：[Worker Previews](https://developers.cloudflare.com/workers/previews/)、
[自定义域名](https://developers.cloudflare.com/workers/previews/custom-domains/)、
[资源隔离](https://developers.cloudflare.com/workers/previews/resources/)、
[Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)。

## Optional AI acceptance

AI is disabled by default. Current `mail-ai` uses dedicated D1 and R2 with its own saved AI settings. AI generation sends selected email text to an external service. AI processing and migration 0030 require separate authorization. Real-provider acceptance uses authorized provider requests. See [AI setup](AI.md).


AI language preferences and Telegram automatic summaries follow the
[SPEC](specs/ai-language-and-telegram-summary.md). Migration 0031 is additive,
but the old production binary only accepts schema 30. The existing independent
`mail-ai` D1 can be migrated with explicit authorization without upgrading
production D1. For production or any target sharing production D1, deploying a
new PRE alone cannot make that database upgrade safe. Arrange the authorized
compatibility rollout (schema-version tolerance only, retaining old Telegram
code) before remote migration; do not use the full feature as that bridge, since
its schema-30 Telegram gate stops enqueueing new notifications. Record any blocked Telegram PRE
acceptance rather than treating the migration-required UI as a feature pass.
Do not enable automatic AI or generate from real shared email during acceptance
without explicit authorization for that external processing and settings write.
The ordinary Telegram test button sends a fixed test message and does not prove
AI outbox processing. Local synthetic dispatcher tests cover that handler path.

### Schema 32 summary/classification acceptance

Follow the [current SPEC](specs/ai-summary-and-automatic-classification.md). Migration 0032 requires explicit target-D1 migration authorization, backup/restore-point review and a compatible application rollout. A schema-version-only bridge is insufficient for category writes; pause those writes during cutover or use a reviewed dual-write bridge. Keep the existing independent PRE D1 and R2 bindings. Validate the exact committed SHA: AI settings default-off/readback, cache-only reader GET, six category filters and retired links, authentication and readiness. Enabling auto-classification, saving settings or generating real summaries needs separate write/external-processing authorization. Local fake-provider tests cover inbound enqueue and scheduled leases; HTTP checks alone do not prove email()/Cron execution. No production deployment is implied.
