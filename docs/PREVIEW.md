# Preview 域名与邮件身份管理

使用 Cloudflare 原生 Worker Previews 部署，要求 Wrangler >= 4.135.0。
已有较新全局 Wrangler 时可直接使用全局命令。仓库本地构建、迁移与测试继续遵循
`package.json` 的 Bun 和 Wrangler 版本；不要使用本地旧版 Wrangler 执行新 Preview 命令。

本项目采用**共用生产数据、独立发布代码**的 Preview 模式。`previews.d1_databases`
的 `database_id` 与生产 `DB` 相同，`previews.r2_buckets` 的 `bucket_name` 与生产
`BUCKET` 相同。邮件、域名、地址、Owner 账号及持久化设置共用；在 Preview 中
保存、删除或配置规则会直接影响生产。新代码可单独发布到 Preview，无需同时
发布生产代码。

1. 将 `wrangler.preview.deploy.toml.example` 复制为被忽略的
   `wrangler.preview.deploy.toml`，从当前生产绑定填写 D1/R2 标识及账号 ID，
   核对线上实际绑定；真实资源标识不得提交。域名接入的
   `MAIL_IDENTITY_WORKER_NAME` 指向生产收信 Worker。复制生产非敏感变量，
   保留 Preview 专用的 `APP_ENV`、`APP_BASE_URL`、`APP_VERSION`。
2. Preview 专用域名配置为 `enabled=false`、`previews_enabled=true`。
   地址格式是 `<preview-name>.<preview-domain>`，不是 Preview 域名本身。
3. 检查共享数据库的 schema 版本与待发布代码兼容。此次切换无需 migration。
   后续 schema 变更同时影响两套代码，必须按远程迁移授权流程核验并保证当前
   生产版本兼容；不要为发布 Preview 自动迁移或重置数据库。
4. 使用现有生产 Owner 账号登录，不初始化或覆盖 Owner，不导入原临时 Preview
   账号。不同 hostname 的 Cookie 独立，需要分别登录。原独立 Preview 资源不再
   用于当前地址；清理前核对旧版本引用，不自动删除它们。
   Preview 不继承生产 secrets，也无法从 Cloudflare 读取其明文；需单独输入或
   使用权限 `0600` 的私有 secrets 文件配置。缺少对应 Key 时，该服务不可用。
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

网页中的“添加邮件域名”核验域名及所属 Zone，不自动修改 MX/SPF/DKIM 等 DNS。
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
[资源隔离](https://developers.cloudflare.com/workers/previews/resources/)。
