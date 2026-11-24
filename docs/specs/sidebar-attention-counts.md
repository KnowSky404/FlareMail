# 侧栏计数 Spec

| 分类 | 数字含义 |
| --- | --- |
| Inbox | 当前 Owner、域名或地址下，未删除、未归档的未读收件 |
| Drafts | 同一身份范围的未删除草稿 |
| Sent、星标、归档、垃圾箱、标签和管理入口 | 无徽标 |

桌面、折叠侧栏、平板及手机导航共用规则。零值和当前身份尚未加载的计数隐藏，1–99 显示实际值，超过 99 显示 `99+`。完整数字用于可访问描述和 Tooltip。切换身份时，旧范围的异步结果不能覆盖当前徽标。搜索、分页和收件分类不改变这两个徽标的计数口径。

已发送列表继续显示真实投递状态。Owner 范围的待处理异常改由顶部铃铛展示，可以确认、重新打开并查询历史。参见 [投递异常关注 Spec](delivery-attention-lifecycle.md)。原始投递统计、文件夹总数和搜索结果总数保留各自语义。

## 本地验证记录（2026-10-10）

任务 worktree：`/tmp/flaremail-sidebar-counts`；分支：`fix/sidebar-mailbox-counts`；基线：`a7b9f78c1b72dccde15d7fdc621e2061f78d7285`。原主工作树保持不变。

- Bun 1.4.2；`bun run test`：628 项通过，0 失败；`bun run check`：0 错误、0 警告；`bun run build` 通过。
- Chromium：1280×900 桌面 4 项、390×844 手机 3 项、320×720 窄屏 3 项通过；手机/窄屏各跳过 1 项桌面专用登录统计用例。覆盖现有身份未读/自动已读、关注徽标、延迟响应、归零和删除→缓存文件夹切换→撤销的范围计数。
- Linux WebKit 桌面和 Firefox 桌面各 1 项通过。各浏览器导航区域的 WCAG 2.1 AA 检查、页面标题/非空内容、无框架错误遮罩、控制台、键盘进入发送列表和无横向溢出均通过。未验证真实 iOS/Safari。
- Browser 插件不可用，采用仓库 Playwright 1.58.2 和已有完整浏览器包。仅使用隔离本地状态 `/tmp/flaremail-e2e/sidebar-counts/<project>/state`，端口 4273/4274/4275/4280/4283；复用已通过且内容未变的构建，串行启动各项目。临时测试配置与日志均位于 `/tmp/flaremail-sidebar-*`。
- 截图：`/tmp/flaremail-attention-desktop.png`、`/tmp/flaremail-attention-mobile.png`、`/tmp/flaremail-attention-narrow.png`，另有 WebKit/Firefox 同名项目截图。边界用例同时模拟统计 API 和列表嵌套 metrics，保持两种响应一致；其大数/零值不代表真实供应商数据。
- 未运行 CI、PRE、生产部署、远程迁移或真实邮件供应商验收。
