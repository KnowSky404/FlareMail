# Preview 域名与邮件身份管理

使用 Cloudflare 原生 Worker Previews 部署，要求 Wrangler >= 4.135.0。
已有较新全局 Wrangler 时可直接使用全局命令。仓库本地构建、迁移与测试继续遵循
本机最新已安装的 Bun 稳定版（满足 `engines.bun` 最低版本）及项目锁定的 Wrangler；
`packageManager` 仅记录 CI 基准，不强制本地 Bun 与之完全相等。
不要使用本地旧版 Wrangler 执行新 Preview 命令。

## 默认验收顺序

先在隔离本地数据和 fake/demo provider 上完成实现、测试、检查和构建，提交后
再在已授权的范围内发布远程 Preview；生产发布另需明确授权。普通开发或文档
修改不自动部署。`bun run preview` 是本地 Worker，`wrangler preview` 才发布
原生远程 Preview；版本预览用于需要复用生产 secrets 检查某个上传版本的场景。
`bun run deploy:dry-run` 只检查公开本地配置的打包，不能代替目标 Preview 的
绑定、变量和 secrets 核对。

本项目采用**共用生产数据、独立发布代码**的 Preview 模式。`previews.d1_databases`
的 `database_id` 与生产 `DB` 相同，`previews.r2_buckets` 的 `bucket_name` 与生产
`BUCKET` 相同。邮件、域名、地址、Owner 账号及持久化设置共用；在 Preview 中
保存、删除或配置规则会直接影响生产。新代码可单独发布到 Preview，无需同时
发布生产代码。

默认远程验收使用只读页面/API。保存、删除、域名同步、真实发信/Telegram 及
路由变更需要覆盖相应生产影响的用户授权；不要运行自动化 fixture 或初始化
Owner。打开未读收件邮件（包括分栏和独立阅读链接）会自动 PATCH 已读状态，
属于生产数据写入；默认只读验收使用列表和 GET 元数据/统计接口，不打开这类
阅读页面或启用分栏。读/未读交互测试优先回到隔离本地环境，或使用另行授权
的独立测试资源。行为契约见 [导航与已读状态 Spec](./specs/mailbox-navigation-and-read-state.md)。
发布后记录提交 SHA、URL、部署/版本 ID、目标绑定及验证结果，核对生产流量未
切换；`/api/health` 只证明存活，已认证的 `/api/readiness` 才检查就绪状态。

1. 将 `wrangler.preview.deploy.toml.example` 复制为被忽略的
   `wrangler.preview.deploy.toml`，从当前生产绑定填写 D1/R2 标识及账号 ID，
   核对线上实际绑定；真实资源标识不得提交。域名接入的
   `MAIL_IDENTITY_WORKER_NAME` 指向生产收信 Worker。复制生产非敏感变量，
   保留 Preview 专用的 `APP_ENV`、`APP_BASE_URL`、`APP_VERSION`。
2. 默认使用 Cloudflare 返回的
   `https://<preview-name>-<worker>.<account-subdomain>.workers.dev`，
   并将 `APP_BASE_URL` 设置为该地址。不创建 Preview 自定义域名关联。
3. 检查共享数据库的 schema 版本与待发布代码兼容。
   后续 schema 变更同时影响两套代码，必须按远程迁移授权流程核验并保证当前
   生产版本兼容；不要为发布 Preview 自动迁移或重置数据库。
4. 使用现有生产 Owner 账号登录，不初始化或覆盖 Owner，不导入原临时 Preview
   账号。不同 hostname 的 Cookie 独立，需要分别登录。此前创建的独立 Preview
   数据库、临时账号、空 R2 桶及本机登录文件已按用户要求删除。旧部署历史仍可
   保留代码记录，但其旧数据绑定已不可用；不再使用旧部署地址。
   **原生 Worker Preview** 不继承生产 secrets，也无法从 Cloudflare 读取其明文；需单独输入或
   使用权限 `0600` 的私有 secrets 文件配置。缺少对应 Key 时，该服务不可用。
   域名和邮箱地址页面优先显示当前环境未配置密钥的提示；共享 D1 中的历史
   供应商错误会保留，但不能据此认定当前 Preview 的密钥无效或权限不足。
   缺少 Telegram Token 时将 Preview 的 `TELEGRAM_ENABLED` 设为 `false`，
   避免配置校验阻止网页访问；生产 Telegram 功能及其他生产配置保持不变。
5. 完成 `bun test`、`bun run check`、`bun run build` 和 Chromium 桌面/手机 QA，
   提交后执行：

   ```sh
   wrangler preview --config wrangler.preview.deploy.toml --name mail-identities --ignore-base-config --message "git <commit>"
   ```

6. 核对 Preview 部署 ID、D1/R2 与生产一致、应用版本、登录、身份管理页面及
   `/api/health`，再确认生产 deployment ID 没有变化。不要执行 `wrangler deploy`
   来发布原生 Preview，它会部署生产。

## 直接复用生产密钥的版本预览

如果需要与生产共用数据库和现有密钥，可使用 **Version URL**。这是与上述
原生 Worker Preview 不同的发布方式：`wrangler versions upload` 上传新版本，
保留当前 Worker 的既有 secret 绑定，但不改变生产流量分配。密钥不会被读取、
导出或重新输入；缺少的密钥也不会自动生成。

1. 从 `wrangler.version-preview.deploy.toml.example` 创建被忽略的私有
   `wrangler.version-preview.deploy.toml`。填入生产 D1/R2 绑定和线上非敏感变量，
   包括 Telegram 开关、Bot 用户名等；不要只依据可能过时的本机生产配置。
2. 将 `APP_ENV`、`APP_BASE_URL`、`APP_VERSION` 设置为此预览的值，
   `MAIL_IDENTITY_WORKER_NAME` 仍指向生产收信 Worker。保留当前生产的
   compatibility date/flags。不要配置新的 routes、DNS 或 Cron。
3. 完成构建和校验，使用 `--dry-run` 检查版本打包，再执行：

   ```sh
   wrangler versions upload --config wrangler.version-preview.deploy.toml --preview-alias function-check --secrets-file .env --message "git <commit>"
   ```

4. 用返回的 `https://function-check-<worker>.<account-subdomain>.workers.dev`
   入口验证，核对新版本的 D1/R2、secret **名称**、Telegram 开关和生产 deployment
   ID。不执行 `wrangler versions deploy`、`wrangler deploy` 或 `wrangler triggers deploy`。

两个入口分别核验。原生 Preview 的资源元数据 `urls` 应包含默认的 `workers.dev`
入口，HTTPS、登录页与健康接口均应可访问。此前的 Preview 自定义域名已按用户
要求移除，不在后续发布中自动恢复。移除旧关联时先核对域名 changeset 只删除目标
Preview 域名，没有新增/冲突及生产域名修改；保留生产域名、其他域名和流量。
此清理只涉及 Preview 网站入口，不调整邮件 MX 或邮件路由。

本机项目根目录的 `.env` 用于保存有明文来源的应用密钥，权限必须为 `0600`，
且已被 Git 忽略。当前保存 `CLOUDFLARE_EMAIL_ROUTING_TOKEN`；后续对话和版本
预览部署从此文件读取，无需重新传递 Token。`--secrets-file .env` 将它作为 secret
上传，已有的 Resend/Telegram secret 绑定继续保留。不要把 `.env` 当作已保存所有
远程密钥的备份：Cloudflare 上现有 secret 的明文无法读取回本机。

配置 Token 时先只读验证有效性、目标 Zone 和规则读取能力；验证不创建邮件
路由、不改 catch-all 或 DNS。设置 secret 不等于验证真实收发信。
存在未发布的新版本时，`wrangler secret put` 会拒绝直接更新生产，
`wrangler versions secret put` 则基于最新上传版本创建版本。使用上述版本上传
命令更新 Preview，避免为配置 Token 将预览代码发布生产。

核对生产配置时，先读取生产 deployment 指向的 version，再检查该 version 的
bindings；Worker settings 可能显示最新上传的预览配置，不代表生产流量配置。

Version URL 与原生 Worker Preview 都使用各自的 `workers.dev` 地址；原生 Preview
不会自动切换到 Version URL 的版本，也不会因此取得生产密钥。
两种入口均使用生产 Owner，但需要分别登录。生产密钥轮换后需重新上传版本，
既有预览不会自动同步新值。Email Routing 和 Cron 仍执行生产部署的代码。

## 从网页接入邮件域名

管理员为目标环境配置 `MAIL_IDENTITY_WORKER_NAME` 和
`MAIL_IDENTITY_ACCOUNT_ID`，并添加限于目标邮件 Zone 的 Cloudflare Token：

- `CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN`：Zone Read、Email Routing Rules Read。
- `CLOUDFLARE_EMAIL_ROUTING_TOKEN`：创建/删除规则需要 Email Routing Rules Edit。
  若不提供单独读取 Token，管理 Token 还需包含 Zone Read 和规则读取权限。
- `RESEND_API_KEY`：发信与域名发信状态检查使用生产 Resend 账号所需的 Key。

向一个原生 Preview 添加 secret 使用：

```sh
wrangler preview secret put CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN --name mail-identities --config wrangler.preview.deploy.toml
```

通过交互式输入传递 Token，不写入配置、命令参数或版本控制。重新部署时使用
所需 secrets 的受限文件和 `--secrets-file`，并核对部署后的 secret 名称；当前
命令采用 `--ignore-base-config`，不从 Previews Base 自动补入 secrets。

进入“域名”或“邮箱地址”时，页面先读取本地配置，再通过已登录的
`POST /api/workspace/mail-identities/sync` 自动发现 Token 可访问的本账号 Zone。
同步识别指向配置收信 Worker 的精确邮箱规则及 catch-all，导入对应域名与地址；
无需手动填写已有配置的 Zone ID。也可以点击“同步 Cloudflare 配置”重新发现。
属于其他 Worker、转发目标、重复或无效的规则不会导入，catch-all 不会虚构邮箱地址。
Cloudflare 接口只执行读取，不创建/修改/删除路由或 DNS。导入的规则标记为
`imported`，不取得规则删除权限，也不会自动启用发信。重复同步保留已有名称、
签名、启停、删除及操作状态，不恢复已删除地址。同步失败时仍展示本地配置和重试提示。
新接入且确认指向本应用的 catch-all 域名初始采用未知地址收集；既有域名的
未知地址策略保持不变。此同步写入的是共用 D1 的身份记录，两种环境都能看到。

本地配置可见不等于本次 Cloudflare 同步成功。同步错误区分 Token 权限、连接失败、
超时和限流；接口只返回安全的 `details.reason`，不暴露 Token 或原始供应商响应。
发布时除登录页和健康接口外，还应在 Workers 运行时核验真实 Zone/规则读取，
避免仅在 Bun 中验证通过而漏过平台调用差异。

“手动接入其他域名”用于尚未发现的配置；其中“添加邮件域名”核验域名及所属 Zone，不自动修改 MX/SPF/DKIM 等 DNS。
接入后检查域名状态，再创建邮箱地址。缺少 Token 或部署映射时，页面会显示
配置提示；已有域名/地址的本地设置仍可以编辑。域名设置可启停域名及切换未知
地址策略，地址可编辑名称和签名；已有的地址启停、删除、恢复及发信操作继续可用。

**原生 Preview 的 HTTP 测试不代表真实收信。** Email Routing 与 Cron 目标是
Worker 的生产 handler，不能选择某个原生 Preview。本项目共用数据时继续由生产
Worker 收信及执行定时任务，Preview 网页可查看其写入的邮件，但收信处理代码
仍是生产版本。只有需要测试新的 `email()` / `scheduled()` 代码时，才另行安排
接收/定时任务测试；无需为了网页 Preview 同时发布生产。配置收信规则时使用
生产 Worker；不要把 Wrangler OAuth 登录凭据当成应用的长期管理 Token。

参考：[Worker Previews](https://developers.cloudflare.com/workers/previews/)、
[自定义域名](https://developers.cloudflare.com/workers/previews/custom-domains/)、
[资源隔离](https://developers.cloudflare.com/workers/previews/resources/)、
[Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)。
