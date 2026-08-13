# TODO

## 当前优先级

### 已完成
- 线程与会话视图：已支持对话线程聚合、展开整段往来和线程内消息切换。
- 生产发信 Provider：生产只允许 Resend；`demo`/fake 仅可在 development/test 显式启用。
- 投递回执与状态同步：已支持 Resend webhook 校验、D1 回执落库和 UI 回执时间线展示。
- 单管理员安全认证：PBKDF2、D1 session、Cookie、CSRF/Origin、登录限速和 bootstrap 流程。
- 版本化 D1 migrations、入站去重、R2 原文/附件落库和 ownership 下载。
- Cloudflare 风格响应式应用壳、light/dark/system、移动端 drill-in 与全屏纯文本写信。

## 第二阶段

### P2 草稿增强
- 自动保存草稿：已支持写信停顿后自动保存，并在关闭前兜底保存。
- 草稿冲突处理与最后编辑时间提示。
- 收件人补全、最近联系人、常用抄送模板。

### P2 收件箱效率功能
- 归档、批量选择、多选操作。
- 标签/分类筛选。
- 服务端全文搜索、结果分页与 cursor（当前 UI 已支持对已加载邮件搜索/筛选）。

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
- 关键 API 与 Worker 日志埋点。
- D1 / R2 / Email Routing 异常监控。
- 错误追踪与操作审计。

## 备注
- 当前最推荐的下一步是先做“草稿增强 + 收件箱效率功能”。
- 如果要跑通真实回执链路，需要在运行环境中配置 `RESEND_WEBHOOK_SECRET`，并让 Resend webhook 指向 `/api/webhooks/resend`。
- 工作台发送、重试、自动回信与入站通知现已统一到 Resend gateway；development/test 可显式使用 fake provider，production 不再回退 Cloudflare 原生或 demo 外发。
