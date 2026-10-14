# 头像菜单与 About 弹窗 SPEC

状态：已实现并完成隔离本地验收；尚未发布 PRE 或生产。核实日期：2026-10-14。
基线：`origin/main` / `c6d9ea974611c0a15f377d5cc9422ed6ff9f1f03`。
任务 worktree：`/tmp/flaremail-account-menu-about`；分支：`feat/account-menu-about`。

## 核实与目标

基线中的头像菜单包含账号信息、“打开设置”和“退出登录”；桌面侧栏及移动导航已有设置入口。本次移除头像菜单中的“打开设置”，新增 About，点击后打开居中弹窗。保留账号摘要、退出登录及导航中的设置入口。

用户已确认：作者信息使用版权署名 `© KnowSky404`；版本仅展示 `package.json.version`，不附加 `APP_VERSION` 部署标识。

## 展示与交互

菜单顺序为账号摘要、**关于 / About**、**退出登录 / Sign out**；About 使用信息图标，文案跟随界面语言。桌面与手机复用同一账号菜单；基线在手机隐藏桌面顶栏，本次在手机右上角补充头像入口并保留写信按钮。弹窗标题为“关于 FlareMail / About FlareMail”，紧凑单列展示以下内容：

| 内容 | 展示契约 |
| --- | --- |
| 项目 | 现有 FlareMail Logo 和名称 |
| 版本 | `v` + 包声明版本；当前基线为 `v0.3.0`，随包声明更新 |
| GitHub | 可点击的完整 URL `https://github.com/KnowSky404/FlareMail` |
| 作者 | `© KnowSky404` |

- 点击 About 先关闭菜单，等待 DOM 更新，再打开弹窗；不导航、不刷新页面、不触发保存，也不请求 GitHub 或其他外部资源。
- 复用共享 Dialog 的 `sm` 尺寸，最大宽度 384 px；桌面、手机均在视口居中，长 URL 可换行，小屏内容可滚动且无横向溢出。
- 打开后焦点进入关闭按钮，Tab / Shift+Tab 在弹窗内循环；关闭按钮、Escape、点击遮罩均可关闭，关闭后焦点返回头像按钮，而不是已卸载的菜单项。
- 弹窗采用 `role="dialog"`、`aria-modal="true"` 和标题关联，沿用项目浅色/深色主题与可见焦点样式。
- GitHub 链接新标签页打开，并设置 `rel="noopener noreferrer"`。只渲染本地项目元数据，不自动查询仓库版本。
- 邮箱视图、筛选、URL 和设置页未保存内容保持原状。

## 实现与兼容

顶栏回调由 `onEditProfile` 替换为 `onOpenAbout(trigger: HTMLElement | null)`。共享账号菜单在关闭前捕获实际触发按钮，使用不同的桌面/手机菜单 ID，避免重复 ID 和恢复焦点到隐藏按钮。页面管理弹窗状态和焦点恢复目标，About 组件在页面弹层区域渲染，不嵌套在顶栏内；视口变化时后备焦点选择当前可见的头像按钮。移除仅供旧菜单入口使用的翻译和通知文案。

页面服务端加载新增 `projectVersion: string`，从 `package.json` 读取，仅向浏览器返回版本字符串。正常及空工作区加载路径均提供该字段。独立 About 组件接收版本及弹窗控制属性，不读取部署配置或私有文件。

现有设置页浏览器测试改用桌面侧栏或移动导航，并保留管理组件按需加载、下载失败恢复和设置保存验证。About 浏览器用例纳入现有 Chromium、WebKit、Firefox 项目。

无需新增 HTTP API、数据库 migration、绑定、环境变量、依赖或品牌图片。日常入口见 [用户指南](../USER_GUIDE.md#settings-and-notifications)。本地门禁及远程流程遵循 [开发指南](../DEVELOPMENT.md) 与 [Preview 指南](../PREVIEW.md)。

## 验收要求

- 菜单移除旧入口，账号摘要、About、退出登录正确；桌面和手机设置入口可用。
- 弹窗版本与包声明一致，仓库链接、作者署名、中英文文案、两种主题正确；打开弹窗不导航、不发起写请求或外部请求。
- 覆盖鼠标与键盘激活、三种关闭方式、焦点循环/返回，以及未保存设置和 URL 保留。
- Chromium 覆盖 1280×900 桌面、390×844 手机、320×720 窄屏，补充 Linux WebKit / Firefox 及弹窗 WCAG 2.1 AA 自动扫描。Linux WebKit 不等于真实 iOS / Safari，自动扫描不等于屏幕阅读器验收。
- 提交前串行运行 `bun run test`、`bun run check`、`bun run build`；浏览器验证使用隔离本地 D1/R2 和固定合成数据，截图保存在 `/tmp`。
- 本地证据、PRE、生产、远程迁移和真实供应商证据分别记录；本任务没有远程发布授权。

## 本地验收记录

环境：Bun 1.4.3、项目锁定的 Playwright 1.58.2 / Wrangler 4.113.0；Browser plugin 不可用，采用仓库 Playwright。仅使用隔离本地 D1/R2 和 demo provider，未复制私有配置。

| 验证 | 结果 |
| --- | --- |
| `bun run test` | 633 项通过，0 失败 |
| `bun run check` | 0 错误，0 警告；工具仍输出基线已有的 tsconfig alias 提示 |
| `bun run build` | 通过；共享菜单最终产物由标准桌面 E2E 启动脚本构建，其余项目复用同一产物 |
| Chromium desktop，1280×900 | 首批 5 项及追加回归 3 项通过，共 7 个不同场景；含 About、设置分区、按需加载/失败恢复、Tooltip 和头像 |
| Chromium mobile，390×844 | 5 项通过；含 About、设置分区和账号/邮件/阅读头像 |
| Chromium narrow，320×720 | 4 项通过；含 About 和设置分区 |
| Linux WebKit desktop，1280×900 | About 3 项通过 |
| Firefox desktop，1366×900 | About 3 项通过 |
| 文档及差异 | 39 个本地文档链接有效，`git diff --check` 通过 |

About 用例同时验证页面标题和非空工作区、无框架错误覆盖层/控制台错误、菜单文案、元数据、URL 保留、两种主题、弹窗居中和无横向溢出，以及弹窗 WCAG 2.1 AA 自动扫描。另覆盖中英文、键盘焦点循环/返回、关闭按钮/Escape/遮罩、设置未保存编辑及退出登录；仅打开 About 时未发生写请求或外部请求。

浏览器状态位于 `/tmp/flaremail-e2e/account-about/<project>/state`，端口为 4373/4374/4375/4380/4383。除首批标准桌面流程外，临时配置 `/tmp/flaremail-about-playwright.config.ts` 与派生启动脚本仅省略重复构建；保留仓库原有 fixture、顺序迁移和 `--local --persist-to` 参数。所有项目串行运行，临时服务在测试结束时停止。

环境排查：首轮缓存缺少 ffmpeg，后改用现有 `ffmpeg-1011`，三个引擎均显式使用匹配 Playwright 1.58.2 的浏览器二进制。一次手机初始化进程意外终止，重跑完成；WebKit 首轮初始焦点断言未通过，诊断重跑和明确聚焦后再发按键的最终完整用例通过，未放宽弹窗焦点断言。Firefox 二进制探测报告 user namespace `EPERM`，仅该本地测试使用 `MOZ_DISABLE_CONTENT_SANDBOX=1`，并将 XDG 目录置于 `/tmp`；未修改应用配置。

日志：`/tmp/flaremail-about-{desktop,desktop-regression,mobile,narrow,webkit-desktop-final,firefox-desktop}.log`。截图：`/tmp/flaremail-about-<project>-{light,dark}.png`；已检查桌面、手机和窄屏截图。Linux WebKit、自动规则和 fake provider 不等于真实 iOS/Safari、屏幕阅读器或真实邮件供应商验收。本轮未运行 CI、PRE、生产部署或远程迁移。最终交付消息记录包含本 SPEC 的提交 SHA。

## v1.0.0 发布准备（2026-10-14）

上述本地记录完成后，功能提交 `6e7eab9c80876d59e140ce174bade942c890f72f` 已部署到 [PRE](https://mail-identities-flaremail.littlecontrol.workers.dev)，部署 ID 为 `86ad2334-c960-41b7-a06e-94209f111727`。公开只读验收确认登录页、健康接口、未认证接口保护和本地构建资源指纹；未持有 Owner 会话，未自行验证远程 About 交互或已认证 readiness。用户随后确认 PRE 无问题，并授权推送代码、生产部署和发布 1.0 正式版。

本次将 `package.json.version` 更新为 `1.0.0`，About 随包声明显示 `v1.0.0`；不改动依赖、数据库或供应商配置。版本更新后的本地验证、PRE、当前提交的机器人审查、合并、生产和 Release 安全扫描分别保留证据，发布结果以实际部署及 GitHub 记录为准。

1.0 本地产物重新通过 633 项测试、类型检查、构建及 high/critical 依赖审计；版本显示、两种主题、居中布局、键盘焦点和弹窗 WCAG 2.1 AA 检查在上述五个浏览器项目各通过一项。此轮复用一个隔离本地 fixture，仍为单 worker 串行运行。审查截图：[桌面](../images/account-about-desktop.png)、[手机](../images/account-about-mobile.png)。日志为 `/tmp/flaremail-v1-{unit,check,build,audit,browser}.log`。
