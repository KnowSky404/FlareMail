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
- 仓库中的 [wrangler.toml](./wrangler.toml) 只保留可公开提交的模板配置
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

先记录当前提交、导出远程数据库并查看待应用 migrations。备份文件只保存在受保护的运维目录，不提交仓库：

```bash
git rev-parse HEAD
bun x wrangler d1 export flaremail-db --remote --config wrangler.deploy.toml --output /secure/path/flaremail-before-migration.sql
bun x wrangler d1 migrations list flaremail-db --remote --config wrangler.deploy.toml
```

再按版本应用远程 D1 migrations。Wrangler 会逐个应用 migration；失败的 migration 会回滚，先前成功项仍保持已应用：

```bash
bun run db:migrate:remote
```

通过交互式 stdin 注入 Resend secrets；不要把值放进命令行参数、文件或聊天：

```bash
bun x wrangler secret put RESEND_API_KEY --config wrangler.deploy.toml
bun x wrangler secret put RESEND_WEBHOOK_SECRET --config wrangler.deploy.toml
```

远程 bootstrap 也只从当前 shell 读取凭据：

```bash
export FLAREMAIL_ADMIN_EMAIL='admin@your-domain.com'
export FLAREMAIL_ADMIN_NAME='FlareMail Administrator'
export FLAREMAIL_ADMIN_PASSWORD='use-a-long-unique-password'
bun run auth:bootstrap:remote
unset FLAREMAIL_ADMIN_EMAIL FLAREMAIL_ADMIN_NAME FLAREMAIL_ADMIN_PASSWORD
```

部署前建议先跑：

```bash
bun run check
bun test src scripts
bun run build
bun run test:e2e
bun run test:a11y
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
- Resend webhook 指向 `https://<worker-domain>/api/webhooks/resend`
- webhook signing secret 与 `RESEND_WEBHOOK_SECRET` 一致

注意：

- production 必须使用 `OUTBOUND_PROVIDER=resend`，并通过 Wrangler secret 注入 `RESEND_API_KEY`
- 工作台发送、重试、入站自动回信和入站通知统一通过 Resend gateway
- `demo`/`fake` 只允许 development/test 且必须显式设置 `ALLOW_FAKE_SERVICES=true`

## 5. 文件分工

- [wrangler.toml](./wrangler.toml)：公开模板，可提交
- [wrangler.deploy.toml.example](./wrangler.deploy.toml.example)：部署模板，可提交
- `wrangler.deploy.toml`：私有真实部署配置，不提交
- [.dev.vars.example](./.dev.vars.example)：本地变量模板，可提交
- `.dev.vars`：本地真实变量，不提交

## 6. 上线后验证

至少验证这几项：

1. 从外部邮箱发信到 Worker 绑定地址
2. 确认 D1 有入站记录
3. 确认 R2 有 `.eml` 原文
4. 确认通知邮箱收到了通知
5. 确认原始发件人收到了自动回信
6. 从工作台发送到专用测试邮箱，先确认状态为 `submitted`，收到 Resend webhook 后再确认 `delivered`
7. 验证移动端列表→详情→返回、light/dark/system、键盘写信和退出登录

生产证据必须区分：API 受理不等于邮件已送达；只有 `email.delivered` webhook 才能证明 delivered。

## 7. 回滚与恢复

- 应用 migration 前记录提交 SHA、待应用 migration 列表和 D1 导出文件位置。
- `0010_mailbox_archive_and_bulk.sql` 只追加 `archived_at` 字段和索引；应用 `0001`–`0010` 必须按顺序执行，不要修改已发布 migration。
- 运行时回滚优先部署上一已知良好提交；`0001`–`0010` 均不通过无备份 `DROP` 删除业务数据。
- 如果需要恢复数据，先停止写入并由操作者选择导入预迁移 SQL，或使用 D1 Time Travel 恢复到明确 bookmark/timestamp。
- Time Travel 会覆盖数据库并取消进行中的请求，属于破坏性操作，执行前必须再次导出当前状态并取得明确批准。
- R2 原始 `.eml` 和附件不要在代码回滚时删除；恢复 D1 后抽样核对 ownership、object key 与行数。

示例（必须把占位符替换为已确认目标，并在执行前审阅）：

```bash
bun x wrangler d1 time-travel restore flaremail-db --timestamp=<UNIX_TIMESTAMP> --config wrangler.deploy.toml
```

## 8. 常见故障

- `/api/health` 显示 schema 未就绪：检查 `migrations list`，不要绕过 migration 直接修改 `schema.sql`。
- production 启动或发送返回 503：检查 D1/R2 binding、`OUTBOUND_PROVIDER=resend`、发件地址和两个 Resend secrets；production 不会回退 demo。
- 发信停在 `submitted`：检查 webhook URL、签名 secret 和 Resend 投递事件；不要把 `submitted` 手工改成 `delivered`。
- 入站存在 D1 记录但正文/附件不可用：核对 R2 binding、object key 与 ownership；不要直接公开 R2 对象。
- 重复 webhook：以 `svix_id` 去重是预期行为；查看事件时间线，不要重放成新的本地 message。

## 9. 保留策略与安全清理

日常报告和清理使用 `scripts/maintenance.ts`。命令默认 dry-run；远程资源必须显式加 `--remote`，删除还必须显式加 `--apply`。R2 清理只接受已审阅 inventory，并且只处理受管的 `inbound/YYYY-MM-DD/<id>/...` key。

```bash
bun run maintenance -- --config wrangler.toml --json
bun run maintenance -- --remote --config wrangler.deploy.toml --r2-manifest /secure/reviewed-r2-inventory.json --json
```

完整参数、安全边界和 apply 示例见 `docs/DEPLOYMENT.md`。生产维护前必须先导出 D1、记录提交 SHA，并人工审阅 dry-run 报告。

## 10. 生产 smoke checklist（仅供操作者执行，本轮不执行）

1. 记录 preview/production migration list 和 D1 备份；
2. 验证 `/api/health` readiness 和 schema metadata version；
3. 外部邮箱入站；
4. D1 ownership；
5. R2 raw 与附件；
6. expected reject 不产生 Worker failure；
7. 自动回复 loop guard；
8. 工作台 Resend 提交；
9. signed webhook；
10. `submitted` 到 `delivered` 状态；
11. webhook duplicate/out-of-order；
12. stale submitting 与 expired delivery review；
13. mobile、theme、keyboard、logout；
14. Workers `cpuTime`、`exceededCpu`、D1/R2 error 观察。
