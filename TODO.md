# TODO

## 已完成，待操作者在隔离 preview / production 验证

- `0011`–`0016` append-only migrations：多收件人、R2 正文分层、统一垃圾箱、入站技术元数据、owner-scoped FTS5、草稿/外发附件与 R2 cleanup queue。
- To/CC/BCC 地址数组、Reply / Reply All / Forward、RFC threading headers，以及不污染正文的结构化 provider envelope。
- D1 UTF-8 byte 边界、大正文 R2 canonical storage、列表正文隔离、bounded detail cache 和 typed runtime unavailable state。
- Trash / restore / permanent delete / undo 基础闭环，以及默认 dry-run 的 retention、body/attachment orphan inventory。
- FTS5 高级搜索、受限 snippet、稳定 cursor、owner isolation、rebuild/repair 命令和备份/恢复说明。
- 默认纯文本、安全 HTML sandbox、远程图片单封授权、CID ownership route、打印视图和显示问题报告。
- 草稿/外发附件上传、刷新恢复、重命名、取消、失败重试、draft-to-sent 转换、下载与转发包含原附件。
- typed toast、真实全局指标、delivery filter、客户端状态 controller 拆分、LRU/TTL 缓存和显式 snapshot identity。
- clean-checkout CI、完整 Bun suite、typegen/build、Wrangler deploy dry-run、Chromium E2E、axe、320px/200% zoom 门禁。

仓库不会自动执行远程 migration、生产部署或真实邮件 smoke。操作者仍需在隔离 preview 测量近上限 MIME/附件的 CPU、内存和 subrequest，再按 `docs/DEPLOYMENT.md` 完成生产检查。

## 下一阶段核心能力

### 邮箱效率

- 自定义标签 CRUD、邮件映射、全局计数、保存搜索与智能文件夹。
- 联系人、最近/常用收件人、地址自动补全和安全 CSV 导入导出。
- 真正的 Command Palette、可调整列表栏宽、显示密度和跨会话设置同步。
- 可访问的移动端 swipe actions，以及 WebKit/iPhone/iPad 浏览器矩阵。

### 写信与投递

- 纯文本 + sanitized HTML 富文本写信、双格式签名和发送前完整预览。
- Durable outbox、Cloudflare Queue、publisher repair、bounded retry、DLQ 与人工 requeue。
- Undo Send、定时发送、取消与修改时间；测试使用 fake clock/provider。
- 多发件身份仅允许服务端 allowlist 中的已配置 sender。

### 内容与运维

- 完整 MIME 结构树、本地 `.eml` 只读预览。
- 图片/PDF/受限文本附件预览和内存安全的批量下载；Office、压缩包、SVG 与未知二进制保持下载-only。
- `scheduled()` maintenance：outbox/stale claims/session/FTS/trash/orphan/audit retention，破坏操作默认 dry-run。
- 密码修改、session 管理、append-only 安全审计与安全导出。
- 只读发件域 / webhook / Queue / Cron readiness checklist 和生产 SLO/告警。

## 后续增强

- Snooze、规则、模板、PWA 安全壳层、Web Push、受限导出、Passkey/Turnstile。
- 规则默认不得永久删除；PWA/Service Worker 不缓存 authenticated API、正文、附件或 raw MIME。
- 不引入开放注册、营销群发或复杂多租户/RBAC。

## 已知硬化项

- 入站附件下载目前按 ownership、size、MIME、disposition、`no-store` 与 `nosniff` 校验；未来在入站元数据普遍具备 SHA-256 后，再把 checksum 设为强制读取门禁。
- R2 cleanup queue 在存储长期不可用时会保留待处理指针；需定期运行 maintenance 并监控 backlog。
