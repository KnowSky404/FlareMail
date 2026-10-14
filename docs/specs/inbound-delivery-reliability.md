# 收信可靠性与子地址 Spec

核查基线：2026-10-14，`origin/main` 的 `6d084ac7e63b74fd1bffc0ef737465b99a5cd391`。
本次修复不增加 D1 migration、绑定、云资源或邮件路由；本地验证与生产验收分别记录。

## 问题与目标

1. 前次收信异常中断后，15 分钟内重投遇到遗留 processing claim，旧实现直接返回成功，
   即使 D1 和 R2 都没有保存邮件。并发副本也可能在主处理随后失败时被错误接受。
2. Cloudflare 开启 subaddressing 后保留 `message.to` 中的 `+tag`。旧实现仅匹配完整地址，
   因此未单独登记的基础邮箱子地址被永久拒收。
3. 外部 catch-all 把未匹配地址分流至其他 Worker/邮箱。FlareMail 无法保存未送到自己的邮件，
   此分流需独立核对，代码修复不会自动迁移既有路由。

目标：processing claim 不再代表保存成功；子地址采用正确身份且保留真实投递地址；
不绕过禁用、删除、Owner、域名、收信开关或路由状态约束。

## 收信锁与成功边界

- 主收信流程等待 R2 原文/正文/附件和 D1 邮件事务持久化。通知在邮件落盘后执行。
- 已存在的 dedupe 邮件或 completed claim 可以按已完成投递去重。
  completed claim 证明曾经完成提交，不能因用户后来删除邮件而使副本重新进入收件箱。
- 抢锁失败时再次查询邮件：确认竞争处理已提交才返回；未提交则抛出带稳定 code 的
  `InboundIngestBusyError`（`INBOUND_CLAIM_BUSY`）。
- busy 路径不写 R2，不删除/释放其他处理的 claim，不调用永久拒收用的 `setReject`。
- 同一 Message-ID 的并发变体不得覆盖获锁方原文。获锁方失败后，后续实际重投可重新抢锁保存。
- 15 分钟过期只允许后续投递重新抢锁。过期或 maintenance 删除 claim 不会自动重放邮件。

当前没有独立的原信重放队列。Cloudflare 官方 handler 文档未承诺抛出异常后的自动重投；
本次修复消除“未保存却正常返回”的路径，不将 invocation 失败视为已证明的 SMTP 重试机制，
也不承诺云平台/上游邮件服务器发生任意故障时零丢信。

## 子地址身份解析

解析顺序：完整 envelope 地址 → 第一个 `+` 前的基础地址 → 既有未知收件人策略。

- 完整地址存在时优先匹配，包括 disabled/deleted tombstone；不回退到基础地址逃避拒收。
- 完整地址不存在时，子地址继承基础地址的 Owner、域名、生命周期、receive_enabled 和 routing_state。
- 基础地址 disabled/deleted、未启用收信、路由未就绪或归属不符时拒收，不能走 collect 补救。
- 基础地址不存在时仍遵守 reject/collect；collect 要求既有的本 Worker catch-all 和健康约束。
- 保存和 dedupe 使用实际 envelope 地址。因此同一 Message-ID 发到基础地址及不同标签时分别保存，
  同一标签的重投去重。原文/MIME To/Cc/Delivered-To 不因身份归属而被重写。
- 不自动创建 mail_addresses，不赋予子地址新的发信身份；原有邮箱/域名筛选继续使用关联身份 ID。
- Cloudflare 的 subaddressing 开关控制子地址是否匹配基础路由；显式子地址路由优先于基础路由。

## 路由和升级

接收范围由 MX、Cloudflare 规则、目标 Worker 和应用身份状态共同决定。外部 catch-all、Drop、
禁用/删除的规则或 Worker 改名会改变接收范围，不能用网页健康接口证明真实收信。
保留外部 catch-all 的方案继续保留；迁移 catch-all 需要确定旧服务邮件如何处理并单独发布。

升级保持 D1/R2 目标和 Worker 名称一致，先检查迁移兼容性，再发布准确提交。
本修复不改 schema，回退代码不回退数据库或删除原信。发布流程见
[部署指南](../../DEPLOY.md)和[生产清单](../PRODUCTION_CHECKLIST.md)。

## 回归与验收

本地测试使用内存 SQLite 和 fake R2/provider，覆盖：

- 新鲜遗留 claim 的重投明确失败，且没有原信/邮件行写入或其他 claim 改动；
- 并发获锁方落盘前副本失败，落盘后的重投正常去重；
- 获锁方随后 D1 失败时副本也不能成功，下一次实际重投能保存；
- 首次去重查询与竞争提交之间的竞态再次确认已落盘结果；
- 子地址保留实际 recipient、正确关联基础身份和 Owner、分标签去重；
- 显式子地址优先、disabled/deleted/receive/routing/ownership 约束及未知地址 collect 边界。

```bash
bun test src/lib/server/db/mail-identities.test.ts src/lib/server/email.integration.test.ts
bun run test
bun run check
bun run build
bun run deploy:dry-run
```

check、build、dry-run 和 Worker 运行验证串行执行。
远程 PRE 的 HTTP 测试不触发生产 `email()`。真实 alias 投递、SMTP 失败/重试、升级期间投递，
必须使用获授权的受控邮件单独验收并记录实际落盘结果。日志抽样和没有残留 claim 都不能证明历史完整性。

2026-10-14 本地验收：642 项测试通过，check 为 0 错误/0 警告，build 和公开配置 dry-run 打包通过。
锁定的 Wrangler 4.113.0 / workerd 在隔离 D1/R2 上验证：alias 处理和重复投递均为 HTTP 200，
同一标签只产生一条邮件，关联基础地址与正确 Owner，R2 原文与 fixture 字节一致；
遗留锁重投为 HTTP 500（`INBOUND_CLAIM_BUSY`），没有新邮件且保留原 claim。
已删除显式子地址产生拒收日志并且不写入邮件。

该版本 Miniflare 的 `setReject` 回调经过 RPC，本地 HTTP 包装层可能先返回 200；拒收验证同时
检查实际回调日志和 D1 未写入，未将包装层 HTTP 状态解释为生产 SMTP 结果。
本记录未执行远程 PRE、真实邮件、远程迁移、路由变更或生产发布。

官方依据：[子地址及规则](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/#subaddressing)、
[Email Worker handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)。
