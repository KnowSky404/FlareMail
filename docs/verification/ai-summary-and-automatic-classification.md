# 摘要复用与自动分类：本地验收

日期：2026-11-17 UTC。对应 [SPEC](../specs/ai-summary-and-automatic-classification.md)。

任务 worktree：`/tmp/flaremail-ai-summary-classification`；分支：`feat/ai-summary-classification`。
基线：`235c7e35f998ea3932d490a4539d51316a76583f`（已 fetch 核对的 origin/main）。
此文件所属提交包含本地验收的最终实现；后续本地 review 的准确 head、基线、时间和原始输出另外保存在 `/tmp/flaremail-ai-evidence/`，避免为写入被审查提交自身 SHA 而改变 head。

## 实现范围

- 共享阅读组件自动 GET 有效缓存，默认展示摘要和成功时间，只有明确 POST 才生成。
- 同一输入重新生成时保留上次成功结果，失败后刷新仍可读取；更换模型/正文等导致失效时不复用旧结果。
- auto 输出语言统一为保存设置时的工作区语言；手动与后台共用缓存。
- 六类用途分类、旧 social/forums 链接和 API 兼容、人工选择迁移及并发保护。
- 默认关闭且独立授权的新邮件后台分类：入站可选事务、D1 工作记录、Cron 租约、单次调用、限额延后、撤销授权和失败降级。
- Telegram 遇到已有共享分析或抢占失败时延后复用，避免和分类任务竞争后立即降级。
- 迁移 0032、schema 32、Prompt 3；保留原分类列，不重建邮件表、不修改已发布迁移。

## 本地门禁

环境：Bun 1.4.4、cf 1.0.0-beta.32；依赖使用 `bun install --frozen-lockfile`。

| 命令 / 检查 | 结果 |
| --- | --- |
| `XDG_CONFIG_HOME=/tmp/flaremail-ai-config bun run test` | 940 pass，0 fail；123 文件，5643 assertions |
| `XDG_CONFIG_HOME=/tmp/flaremail-ai-config bun run check` | 0 errors，0 warnings；既有 SvelteKit alias 弃用提示未改变 |
| `bun run build` | 完整应用及 Worker 构建通过；后续 dry-run 再次构建最终实现 |
| `XDG_CONFIG_HOME=/tmp/flaremail-ai-config bun run deploy:dry-run` | 通过，仅公开本地配置/临时打包，不发布 |
| 迁移与数据 | 空库、legacy fixture、31→32、原始人工值、独立 AI 值、成功时间、工作删除清理及 schema 快照测试通过 |
| 文档 | `git diff --check` 及修改文档的相对文件链接检查通过 |

本地 cf 最初因 `/root/.config/cloudflare/dev-registry` 只读失败，改用任务专用 XDG 配置目录后全量通过；没有复制凭据或私有配置。

## 浏览器与证据

Browser plugin not available：使用仓库已安装的 Playwright CLI `bun node_modules/@playwright/test/cli.js`，避免全局/缓存 CLI 与项目浏览器 revision 不一致。二进制存于 `/tmp/singdeck-browsers`。

测试流：登录隔离本地工作区 → 打开邮件读取缓存/显式生成或重试 → 检查摘要、时间及分类；设置独立授权；分类深链接、键盘及人工更正。

| 项目 | 结果 |
| --- | --- |
| Chromium desktop，1280×900 | AI、设置、Gmail 工作流 34 项通过；最终标签定位回归另 4 项通过 |
| Chromium mobile，390×844 | 28 项通过，6 项为不适用的桌面功能跳过；最终定位/导航回归 4 项通过 |
| Chromium narrow，320×720 | 28 项通过，6 项桌面功能跳过；最终定位/导航回归 4 项通过 |
| Linux WebKit desktop，1280×900 | 14 项通过，2 项仅 Chromium 桌面控件跳过；最终分类定位 1 项通过 |
| Firefox desktop，1366×900 | 14 项通过，2 项仅 Chromium 桌面控件跳过 |

每个场景检查实际页面内容、交互、无框架错误覆盖、无相关 console errors；摘要/设置包含 axe 检查，窄屏检查无横向页面溢出。分类条允许自身横向滚动，当前分类会自动进入可见区域。暗色、键盘展开/收起、手动应用、错误恢复、语言切换竞态及同一邮件标记变化均有回归。

Firefox 初次 `newPage: Target crashed` 在访问应用之前发生；容器设置 `MOZ_DISABLE_CONTENT_SANDBOX=1` 后可正常启动页面，应用配置未改变。Linux WebKit 与模拟手机不代表真实 iOS/Safari 设备验证。

截图：`/tmp/flaremail-ai-evidence/{project}-automatic-cache.png`、`{project}-categories.png`、`/tmp/flaremail-ai-settings-evidence/{project}.png`。原始日志 `/tmp/flaremail-ai-{test,check,dry-run}.log` 与 `/tmp/flaremail-ai-e2e-*.log`。数据库、桶、身份、邮件均为隔离合成 fixture，AI 为 fake provider 或浏览器 mock；没有调用真实模型、真实 Telegram 或 Resend。

## 远程门禁与发布边界

PRE 发布、独立 PRE D1 的 0032 迁移及相关页面/API 验收尚未获得本次授权，因此尚未执行。未创建功能 PR、未合并、未部署生产、未远程迁移。保留任务分支及 worktree。

后续应对已提交 SHA 单独授权 PRE 发布/迁移，核对恢复点、实际绑定、登录、认证 readiness、AI 缓存 GET、六类筛选和设置页；默认只读，不启用自动处理或发送真实邮件。email()/Cron 使用本地 fake 集成证据说明替代覆盖，不能把 HTTP 存活当作真实触发器验收。

生产共享 D1 升级需独立授权并安排兼容切换。只放宽 schema 版本不能同步旧分类列写入；需暂停分类写入或实施已审查的双写桥接。此功能并非生产桥接部署。
