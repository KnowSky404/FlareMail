# 使用全局 cf 验收 PRE

使用全局 `cf`（已验证 `1.0.0-beta.25`，Node.js ≥ 22.18）和原生 `cloudflare.config.ts`。不再使用直接 Wrangler 命令。旧配置/命令见[历史记录](archive/wrangler-preview.md)，不作为当前操作依据。

## 默认验收顺序

1. 在独立 worktree 从最新 `origin/main` 开发，完成 `bun run test`、`bun run check`、`bun run build`、相关浏览器 QA、`bun run deploy:dry-run`，创建干净原子提交。
2. 仅在已获 Preview 授权时，填写忽略的 `cloudflare.preview.json`（模板 `cloudflare.preview.json.example`），权限 `0600`。必须使用现有生产 Worker 名称、同一 D1/R2 和 Owner；`APP_ENV=preview`，实际 Provider/Auth 配置，关闭自动回复、通知、Telegram，`cron=[]`。不得创建替代资源或初始化 Owner。Preview 使用的生产邮件路由目的 Worker/account 保持不变。
3. `bun run deploy:pre -- <preview-name>` 先构建 Svelte 应用，再在 `worker/` 通过全局 `cf previews deploy --mode preview` 构建并上传原生 Preview，不切换生产流量。名称是合法稳定名称，不把 `/` 等分支字符直接拼进去。记录命令时间、提交 SHA、Preview URL 和部署/版本 ID。
4. 对该提交验收登录、相关业务页面/API、已认证 `/api/readiness`、D1/R2 绑定，并核对生产流量指向没有变化。`/api/health` 仅证明存活，不能替代业务验收；HTTP 验收不能证明生产 `email()`、Cron 或真实投递。
5. **共享生产数据，默认只读**。不要运行 E2E seed、fixture、Owner bootstrap、数据库重置或迁移。打开未读邮件会自动写入已读状态；使用已经读过的消息和只读 HTML/CID GET 接口进行预览验收。真实邮件、Telegram、数据写入及路由/DNS 修改必须在明确授权范围内。
6. PRE 业务验收完成后，分别在 push 和创建 PR 前实际执行 `codex review --base origin/main` 并处理有效问题。等待当前 head 的 Codex Code Review 和 Security Review 完成，再按仓库默认授权 rebase 合并和收尾。实现提交追加后补做受影响本地/PRE 验收及两种 review。

原生 Preview 需要父 Worker 的既有配置/密钥。检查已安装 cf 帮助和父 Worker 现状；不要为了缺少配置改用生产 `cf deploy`。需要上传独立版本而不切生产流量时，可使用 `cf workers versions create --mode production`；先在 `worker/` 核对 `--help`、绑定、secrets 及版本预览域名现状，并记录该路径不能覆盖的原生 Preview 行为。禁止擅自创建生产 deployment 或应用 triggers。

本地隔离替代验证使用 `bun run preview`（全局 `cf dev`）及 `.cloudflare/state`。环境缺少 Owner 登录方式、PRE 配置或运行权限时，保留本地提交/worktree 并说明阻塞；不得把构建、上传或健康检查记为 PRE 验收通过，也不得提前提功能 PR。

## 从网页接入邮件域名

管理员为目标环境配置 `MAIL_IDENTITY_WORKER_NAME` 和
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
未知地址策略保持不变。此同步写入的是共用 D1 的身份记录，两种环境都能看到。

本地配置可见不等于本次 Cloudflare 同步成功。同步错误区分 Token 权限、连接失败、
超时和限流；接口只返回安全的 `details.reason`，不暴露 Token 或原始供应商响应。
发布时除登录页和健康接口外，还应在 Workers 运行时核验真实 Zone/规则读取，
避免仅在 Bun 中验证通过而漏过平台调用差异。

“手动接入其他域名”用于尚未发现的配置；其中“添加邮件域名”核验域名及所属 Zone，不自动修改 MX/SPF/DKIM 等 DNS。
接入后检查域名状态，再从新增地址弹窗创建邮箱地址。缺少 Token 或部署映射时，
页面会显示配置提示；已有域名/地址的本地设置仍可以编辑。域名设置可启停域名及
切换未知地址策略，地址可编辑名称和签名；已有的地址启停、删除、恢复及发信操作
继续可用。刷新失败时保留仍可查看的本地资源，不把读取失败显示成尚未配置。

**原生 Preview 的 HTTP 测试不代表真实收信。** Email Routing 与 Cron 目标是
Worker 的生产 handler，不能选择某个原生 Preview。本项目共用数据时继续由生产
Worker 收信及执行定时任务，Preview 网页可查看其写入的邮件，但收信处理代码
仍是生产版本。只有需要测试新的 `email()` / `scheduled()` 代码时，才另行安排
接收/定时任务测试；无需为了网页 Preview 同时发布生产。配置收信规则时使用
生产 Worker；不要把 cf OAuth 登录凭据当成应用的长期管理 Token。

参考：[Worker Previews](https://developers.cloudflare.com/workers/previews/)、
[自定义域名](https://developers.cloudflare.com/workers/previews/custom-domains/)、
[资源隔离](https://developers.cloudflare.com/workers/previews/resources/)、
[Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)。
