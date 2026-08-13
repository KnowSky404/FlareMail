# Deployment Checklist

## 1. 准备真实配置

不要把真实邮箱、D1 `database_id`、R2 桶名或密钥提交到仓库。

- 复制一份本地变量模板：
  ```bash
  cp .dev.vars.example .dev.vars
  ```
- 按真实环境填写 `.dev.vars`
- 复制部署配置模板：
  ```bash
  cp wrangler.deploy.toml.example wrangler.deploy.toml
  ```
- 按真实环境填写 `wrangler.deploy.toml`
- 仓库中的 [wrangler.toml](/root/Clouds/FlareMail/wrangler.toml) 只保留可公开提交的模板配置
- 真正部署只使用本地私有的 `wrangler.deploy.toml`

推荐本地变量至少包含：

```env
APP_ENV=production
OUTBOUND_PROVIDER=resend
OUTBOUND_FROM_EMAIL=dev@your-domain.com
OUTBOUND_FROM_NAME=FlareMail
AUTO_REPLY_ENABLED=true
INBOUND_NOTIFICATION_ENABLED=true
NOTIFICATION_EMAIL=ops@example.com
```

## 2. 创建 Cloudflare 资源

首次部署前执行：

```bash
bun x wrangler login
bun x wrangler d1 create flaremail-db
bun x wrangler r2 bucket create flaremail-bucket
bun x wrangler r2 bucket create flaremail-bucket-preview
```

把 `wrangler d1 create` 返回的 `database_id` 写进 `wrangler.deploy.toml`。

## 3. 初始化数据库并部署

先备份现有数据，再按版本应用远程 D1 migrations：

```bash
bun run db:migrate:remote
```

部署前建议先跑：

```bash
bun run check
bun run build
bun run deploy:dry-run
```

正式部署：

```bash
bun run deploy
```

## 4. 配置 Email Routing

在 Cloudflare Dashboard 中确认：

- 域名已开启 Email Routing
- `dev@your-domain.com` 这类地址已路由到当前 Worker
- Resend 已验证 `OUTBOUND_FROM_EMAIL` 对应的域名或发件地址

注意：

- production 必须使用 `OUTBOUND_PROVIDER=resend`，并通过 Wrangler secret 注入 `RESEND_API_KEY`
- 工作台发送、重试、入站自动回信和入站通知统一通过 Resend gateway
- `demo`/`fake` 只允许 development/test 且必须显式设置 `ALLOW_FAKE_SERVICES=true`

## 5. 文件分工

- [wrangler.toml](/root/Clouds/FlareMail/wrangler.toml)：公开模板，可提交
- [wrangler.deploy.toml.example](/root/Clouds/FlareMail/wrangler.deploy.toml.example)：部署模板，可提交
- `wrangler.deploy.toml`：私有真实部署配置，不提交
- [.dev.vars.example](/root/Clouds/FlareMail/.dev.vars.example)：本地变量模板，可提交
- `.dev.vars`：本地真实变量，不提交

## 6. 上线后验证

至少验证这几项：

1. 从外部邮箱发信到 Worker 绑定地址
2. 确认 D1 有入站记录
3. 确认 R2 有 `.eml` 原文
4. 确认通知邮箱收到了通知
5. 确认原始发件人收到了自动回信
