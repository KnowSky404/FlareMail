# Deployment Checklist

## 1. 准备真实配置

不要把真实邮箱、D1 `database_id`、R2 桶名或密钥提交到仓库。

- 复制一份本地变量模板：
  ```bash
  cp .dev.vars.example .dev.vars
  ```
- 按真实环境填写 `.dev.vars`
- 将 [wrangler.toml](/root/Clouds/FlareMail/wrangler.toml) 里的占位值替换为真实值：
  - `[[send_email]]`
  - `[[d1_databases]].database_id`
  - `[[r2_buckets]]`

推荐本地变量至少包含：

```env
OUTBOUND_PROVIDER=demo
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

把 `wrangler d1 create` 返回的 `database_id` 写回 [wrangler.toml](/root/Clouds/FlareMail/wrangler.toml)。

## 3. 初始化数据库并部署

先将 schema 应用到远程 D1：

```bash
bun x wrangler d1 execute flaremail-db --remote --file ./schema.sql
```

部署前建议先跑：

```bash
bun run check
bun run build
XDG_CONFIG_HOME=/tmp bun x wrangler deploy worker/index.ts --dry-run --outdir /tmp/flaremail-dry-run
```

正式部署：

```bash
bun run deploy
```

## 4. 配置 Email Routing

在 Cloudflare Dashboard 中确认：

- 域名已开启 Email Routing
- `dev@your-domain.com` 这类地址已路由到当前 Worker
- `send_email` 绑定允许的 sender/destination 与实际配置一致

注意：

- 当前默认 `OUTBOUND_PROVIDER=demo`，表示工作台 UI 发送仍走演示 provider
- 入站自动回信和入站通知由 Worker 原生邮件能力处理
- 如果要把 UI 发送切到 Cloudflare 原生外发，再把 `OUTBOUND_PROVIDER` 改成 `cloudflare`

## 5. 上线后验证

至少验证这几项：

1. 从外部邮箱发信到 Worker 绑定地址
2. 确认 D1 有入站记录
3. 确认 R2 有 `.eml` 原文
4. 确认通知邮箱收到了通知
5. 确认原始发件人收到了自动回信
