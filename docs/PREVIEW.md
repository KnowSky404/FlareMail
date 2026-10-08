# Preview 域名与邮件身份管理

使用 Cloudflare 原生 Worker Previews 部署，要求 Wrangler >= 4.135.0。
已有较新全局 Wrangler 时可直接使用全局命令。仓库本地构建、迁移与测试继续遵循
`package.json` 的 Bun 和 Wrangler 版本；不要使用本地旧版 Wrangler 执行新 Preview 命令。

1. 将 `wrangler.preview.deploy.toml.example` 复制为被忽略的
   `wrangler.preview.deploy.toml`，填写独立 Preview D1/R2 绑定及应用地址。
2. Preview 专用域名配置为 `enabled=false`、`previews_enabled=true`。
   地址格式是 `<preview-name>.<preview-domain>`，不是 Preview 域名本身。
3. 使用单独的迁移配置，将顶层 D1 绑定指向与 `previews.d1_databases` 相同的
   Preview 数据库；先列出待应用迁移，再应用并核对版本。禁止指向生产数据库。
4. 在 Preview 数据库初始化独立 Owner 及本地登录凭据。不要复制生产邮件、
   凭据或其他生产配置；临时账号信息应保存为权限 `0600` 的本机文件。
5. 完成 `bun test`、`bun run check`、`bun run build` 和 Chromium 桌面/手机 QA，
   提交后执行：

   ```sh
   wrangler preview --config wrangler.preview.deploy.toml --name mail-identities --message "git <commit>"
   ```

6. 核对 Preview 部署 ID、D1/R2 隔离、应用版本、登录、身份管理页面及
   `/api/health`，再确认生产 deployment ID 没有变化。不要执行 `wrangler deploy`
   来发布原生 Preview，它会部署生产。

## 从网页接入邮件域名

管理员为目标环境配置 `MAIL_IDENTITY_WORKER_NAME` 和
`MAIL_IDENTITY_ACCOUNT_ID`，并添加限于测试 Zone 的 Cloudflare Token：

- `CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN`：Zone Read、Email Routing Rules Read。
- `CLOUDFLARE_EMAIL_ROUTING_TOKEN`：创建/删除规则需要 Email Routing Rules Edit。
  若不提供单独读取 Token，管理 Token 还需包含 Zone Read 和规则读取权限。
- `RESEND_API_KEY`：域名发信状态检查需要 Resend 域名读取权限；使用专用测试 Key。

向一个原生 Preview 添加 secret 使用：

```sh
wrangler preview secret put CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN --name mail-identities --config wrangler.preview.deploy.toml
```

通过交互式输入传递 Token，不写入配置、命令参数或版本控制。

网页中的“添加邮件域名”核验域名及所属 Zone，不自动修改 MX/SPF/DKIM 等 DNS。
接入后检查域名状态，再创建邮箱地址。缺少 Token 或部署映射时，页面会显示
配置提示；已有域名/地址的本地设置仍可以编辑。域名设置可启停域名及切换未知
地址策略，地址可编辑名称和签名；已有的地址启停、删除、恢复及发信操作继续可用。

**原生 Preview 的 HTTP 测试不代表真实收信。** Email Routing 与 Cron 目标是
Worker 的生产 handler，不能选择某个原生 Preview。要测试真实邮件，使用单独的
接收 Worker，并绑定 Preview D1/R2；`MAIL_IDENTITY_WORKER_NAME` 应指向它。
不要把 Preview 创建的收信规则指向生产 FlareMail，也不要把 Wrangler OAuth
登录凭据当成应用的长期管理 Token。

参考：[Worker Previews](https://developers.cloudflare.com/workers/previews/)、
[自定义域名](https://developers.cloudflare.com/workers/previews/custom-domains/)、
[资源隔离](https://developers.cloudflare.com/workers/previews/resources/)。
