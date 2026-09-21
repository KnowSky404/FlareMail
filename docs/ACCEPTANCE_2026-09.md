# 多域名邮箱可靠性补齐验收（2026-09-21）

本记录基于 `main@cd1b9eb` 及其后的本地提交，按当前工作树代码验收。本轮只使用隔离 D1、浏览器 fixture 和 fake provider；没有部署、写远端 D1、改 Cloudflare 规则、发送真实邮件或 Telegram。

## 缺陷、修复与证据

| 问题 | 修复范围 | 回归证据 |
| --- | --- | --- |
| 地址/域名筛选下按线程批量操作可能展开到筛选外邮件 | UI、client API、路由、workspace 服务和 SQL 贯通 identity/section scope；执行前校验 Owner、范围和数量，回收站明确保持 Owner 全局语义 | `src/lib/server/workspace/mailbox.integration.test.ts`、`src/routes/api/workspace/mailbox/mutate/server.test.ts` |
| 远端规则被外部改目标、已删除地址被重复检查改变状态，以及检查/删除/恢复并发 | 集中验证受管规则的完整目标；保留删除 tombstone 和策略结果；使用操作租约/CAS 丢弃过时结果；恢复不释放仍在执行的删除操作 | `src/lib/server/mail-identities/routing.test.ts`、`check.test.ts`、地址路由集成测试 |
| 发信/collect 的 24 小时健康门槛依赖人工每日检查 | migration 0025、独立 Cloudflare/Resend 只读续检、有限批次/租约/退避，并隔离 Cron 子任务失败；失败不伪造健康时间 | `src/lib/server/mail-identities/health-refresh.test.ts`、`src/lib/server/scheduled.test.ts`、`sending.test.ts` |
| 外部 catch-all 下“删除地址”语义不完整 | migration 0026、删除前服务端预览和显式策略，保留历史邮件与附件；导入路由默认不破坏 | `src/routes/api/workspace/mail-identities/[addressId]/server.test.ts`、`routing.test.ts` |
| 历史地址关联只有只读 dry-run | 增加显式 plan/apply/verify，校验 Owner、记录范围、计划版本和并发状态；保留证据不足/跨 Owner 记录待人工处理 | `scripts/mail-identity-backfill.test.ts` |
| 新写信忽略精确地址筛选；发信阻断原因不清楚 | 精确地址筛选优先选择对应的就绪地址；域/全局视图采用全局默认；回复和草稿保留既有身份；编辑器分别说明地址、域、Resend 和 freshness 状态 | `src/lib/domain/mail/compose-sender.test.ts`、`sender-readiness.test.ts`、`tests/e2e/workspace.spec.ts` |
| Access 边缘过期响应被当作任意 JSON 解析错误，可能丢失编辑状态 | 同源 `/api` 与附件 XHR 加 AJAX 标头；区分 Worker JSON 401、边缘非 JSON 401、已知 Access 登录跳转、403、服务错误及离线/CORS；暂停轮询/自动保存，保留当前标签内编辑，只在重认证后刷新 GET，不重放写请求 | `src/lib/client/api.test.ts`、`tests/e2e/workspace.spec.ts`；WebKit 三项目的发送/附件/阅读 smoke |

## Migration、配置与 API 兼容性

- Schema 从 24 增至 26：追加 `0025_mail_domain_health_refresh.sql` 和 `0026_mail_address_delete_policy.sql`；没有改写旧 migration。空库本地迁移通过，`schema.sql` 与迁移序列同步。
- 发件身份选项新增状态/时间/失败字段，API 为加字段的向后兼容变化；旧客户端可忽略新字段。Access AJAX 标头仅由浏览器 client 加到同源 `/api` 请求，外部 origin 会移除该标头。没有新增生产配置或认证旁路。
- 当前 sender-default 与 Access 恢复改动没有新增 migration；Access 恢复后的 session/workspace/detail 请求为 GET，写操作需用户再次明确触发。
- 历史 backfill 只验证本地工具和合成 fixture；生产 D1 apply 仍需按部署文档备份、核对目标并单独授权。

## 本地验证

均使用项目固定运行时 Bun 1.4.0。

| 命令/项目 | 结果 |
| --- | --- |
| `bun install --frozen-lockfile` | 通过 |
| `bun run test:unit` | 50 个文件，261 pass，0 fail，1816 assertions |
| `bun run test:integration` | 15 个文件，127 pass，0 fail，705 assertions |
| `bun run test:remaining` | 30 个文件，135 pass，0 fail，600 assertions |
| `bun run check` | 0 Svelte errors、0 warnings；有仓库既存 `tsconfig` `baseUrl/paths` 提示 |
| `bun run cf:typegen -- --check` | Worker 类型最新 |
| 独立 Wrangler local D1 存储 | `/tmp/flaremail-acceptance-d1-20260921` 上 migration 0001–0026 全部应用；未使用 `--remote` |
| `bun run search:index -- --mode verify --persist-to /tmp/flaremail-acceptance-d1-20260921 --json` | `target=local`；expected/projected/missing/orphaned 均为 0 |
| `bun run test:e2e` | Chromium：desktop 28、mobile 21、narrow 17，共 66 pass、30 个项目条件 skip、0 fail |
| `bun run test:e2e:webkit` 项目级 Playwright 运行 | desktop、iPhone、iPad 各 7 pass、0 fail。包装命令此前一次受外层进程 SIGTERM（143）；本记录结果来自同一最新代码的三个独立项目运行 |
| `bun run test:a11y` | mobile 2 pass/1 skip；narrow 1 pass/2 skip；0 fail |
| Access 过期 + sender 截图用例 | 当前代码 Chromium desktop 2 pass；截图保存在 `/tmp/flaremail-auth-expired-desktop.png`、`/tmp/flaremail-sender-exact-address-desktop.png` |
| `bun run deploy:dry-run` | build 成功，Wrangler 以 `--dry-run` 结束；没有上传 |
| `bun run release:preflight` | 干净工作树下 `RESULT PASS`；Git、Bun、配置/绑定/schema、FTS/健康/附件/投递、依赖安装与审计、check、typegen、build 均通过；本地只读 |

## 尚未进行的生产验收

本地合成响应不能证明真实 Access 边缘策略已启用或生产会话实际返回预期 401；不能证明真实 Cloudflare Email Routing 规则、Cron 调度、Resend 域名权限/发送、生产 D1 migration、邮件送达或 Telegram 通知。也没有真实 iOS Safari/WebKit 设备测试。获授权后按 `docs/PRODUCTION_CHECKLIST.md` 与 `DEPLOY.md` 分阶段核对；不要把 Worker dry-run 或 fake provider 结果记为生产/送达证据。

`release:preflight` 在实现与文档提交后从干净工作树运行，结果如上。本次仍没有生产部署或远端写入。
