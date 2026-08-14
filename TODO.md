# TODO

## 当前优先级

### 本轮可靠性收口（已实现，待操作者验证）
- clean checkout CI preparation、bounded JSON、production origin/auth hardening、session touch throttle。
- inbound claim lease/recovery、expected reject、RFC 3834 loop guard、schema readiness metadata。
- workspace mutation deltas、targeted ownership queries、draft optimistic conflict actions、Resend expiry review。
- 仍需操作者在 isolated preview 运行 CPU/容量测量和生产 smoke checklist；本仓库不自动执行远程操作。

### 已完成
- 线程与会话视图：已支持对话线程聚合、展开整段往来和线程内消息切换。
- 生产发信 Provider：生产只允许 Resend；`demo`/fake 仅可在 development/test 显式启用。
- 投递回执与状态同步：已支持 Resend webhook 校验、D1 回执落库和 UI 回执时间线展示。
- 单管理员安全认证：PBKDF2、D1 session、Cookie、CSRF/Origin、登录限速和 bootstrap 流程。
- 版本化 D1 migrations、入站去重、R2 原文/附件落库和 ownership 下载。
- Cloudflare 风格响应式应用壳、light/dark/system、移动端 drill-in 与全屏纯文本写信。
- 服务端 mailbox query/filter/cursor 分页、typed API envelope 与前端“加载更多”。
- D1 原子登录限速、请求关联 ID、Workers observability 与只读优先的 retention/orphan maintenance。
- Playwright 隔离 E2E、axe WCAG 2.1 A/AA、44px 触控目标、320px/200% 缩放和 CI 浏览器门禁。

## 第二阶段

### P2 草稿增强
- 自动保存草稿：已支持写信停顿后自动保存，并在关闭前兜底保存。
- 草稿冲突处理与最后编辑时间提示。
- 收件人补全、最近联系人、常用抄送模板。

### P2 收件箱效率功能
- 归档、批量选择、多选操作。
- 标签/分类筛选。
- D1 FTS5 或外部索引（当前服务端 query 为受控 `LIKE` 搜索，并已支持 cursor 分页）。

### P2 邮件内容能力
- 完整 MIME 结构展示。
- HTML / 纯文本安全切换（当前默认只渲染纯文本，HTML 不直接注入 DOM）。
- 内嵌图片与附件预览。
- 附件预览和批量下载（单附件与原始 `.eml` ownership 下载已完成）。

## 第三阶段

### P3 鉴权与账号体系
- 支持多账号 / 多邮箱身份。
- 密码重置、凭据轮换 UI 和 session 管理页面。
- 个人资料、签名、发信身份、转发规则持久化完善。

### P3 运维与可观测性
- 告警目标与 SLO：在 Cloudflare Dashboard 配置 D1 / R2 / Email Routing 错误率和延迟告警。
- 定期运行 maintenance dry-run，人工审阅 retention 与 R2 orphan inventory。
- 错误追踪与操作审计。

## 备注
- 当前最推荐的下一步是“草稿并发冲突处理 + 批量收件箱操作”，同时补生产环境 SLO/告警。
- 如果要跑通真实回执链路，需要在运行环境中配置 `RESEND_WEBHOOK_SECRET`，并让 Resend webhook 指向 `/api/webhooks/resend`。
- 工作台发送、重试、自动回信与入站通知现已统一到 Resend gateway；development/test 可显式使用 fake provider，production 不再回退 Cloudflare 原生或 demo 外发。
