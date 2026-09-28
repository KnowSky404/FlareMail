# Reading-space QA

本文档记录 FlareMail 阅读工作台的尺寸契约、交互验收和证据边界。这里的浏览器数据来自隔离的本地 D1/R2 fixture；它证明本地构建和浏览器交互行为，不代表生产部署、真实邮件投递或真实 Telegram 调用。

## 行为契约

| 区域 | 约束 |
| --- | --- |
| 主侧栏 | 展开宽度 232px，折叠宽度 64px；折叠状态写入 `flaremail-layout-v1`，刷新后恢复。 |
| 邮件列表 | 用户偏好宽度 280–480px，默认 440px；拖拽和 `ArrowLeft`/`ArrowRight`/`Home`/`End` 可调整，`Enter` 恢复默认值。 |
| 详情区 | 分隔条 8px，详情区保留至少 360px；可用空间不足时只临时压缩列表的有效宽度，持久化的用户偏好不被覆盖。 |
| HTML 正文 | iframe 高度为 `clamp(18rem, 68dvh, 56rem)`；普通正文行宽约 78ch，专注阅读行宽约 86ch。 |
| 滚动 | 工作台详情由外层详情区域承载滚动，正文容器不再使用固定 `62vh`/`28rem` 高度制造嵌套滚动。 |
| 专注阅读 | 全局 dialog 接管焦点，背景不可操作；详情标题和关闭按钮各保留一个可见实例，`Escape` 关闭并恢复触发控件焦点。 |
| 独立阅读 | `/messages/[id]` 只返回当前 session 可见的元数据；正文、附件和安全 HTML 继续通过现有 owner-scoped API 读取，HTML 响应使用 `private, no-store`。 |
| 响应式 | 桌面使用列表/详情分栏；900px 及以下进入单面板 drill-in；320px 和 200% 模拟缩放不应产生横向溢出。 |
| 语言 | UI 支持 zh-CN、en 和“跟随浏览器”；选择写入 cookie/localStorage，SSR 初始语言与浏览器 `Accept-Language` 保持一致。数量文本使用 locale plural rules。 |
| 窗口同步 | BroadcastChannel 优先、localStorage 事件回退；只传播邮件状态信号、消息 ID 和会话结束事件，不传播正文、地址或凭据。 |

## 改造前基线快照（2026-09-17）

在本轮布局改造前，Chromium desktop（1280×900）打开安全 HTML fixture 后，浏览器测量为：

```json
{
  "viewportHeight": 900,
  "iframeHeight": 612,
  "articleHeight": 962,
  "scrollOwnerClientHeight": 2785,
  "scrollOwnerScrollHeight": 2785
}
```

`612px` 等于 `68dvh`。正文滚动归属于详情滚动容器；fixture 的长文章没有在 iframe 外再创建第二个正文滚动拥有者。

本快照只用于与改造后比较，不能把 iframe 的声明高度或 `scrollHeight` 当作用户实际可见高度；改造后使用视口、详情面板和祖先裁剪区域的交集计算可见正文空间。

## 先前验证记录（历史）

固定 Bun 1.4.0 的门禁命令：

```sh
FLAREMAIL_BUN14=/tmp/flaremail-bun-tmp/bunx-0-bun@1.4.0/node_modules/.bin/bun
TMPDIR=/tmp "$FLAREMAIL_BUN14" run check
TMPDIR=/tmp "$FLAREMAIL_BUN14" test
TMPDIR=/tmp "$FLAREMAIL_BUN14" run build
```

浏览器验证使用隔离端口和状态目录。以下结果是改造前/中间阶段的历史记录，不作为本轮最终通过结论。仓库的 `bun run test:e2e` 在当时会触发 Playwright 子进程的 `playwright.config.ts.esm.preflight` 解析问题，因此曾使用同一 Playwright 配置由 Node CLI 直接启动：

| 浏览器/范围 | 结果 |
| --- | --- |
| Chromium desktop，完整 workspace suite | `24 passed, 4 skipped` |
| Chromium mobile，完整 workspace suite | `19 passed, 9 skipped`；此前暴露的登录输入同步竞态和 Telegram 主流程均在此结果中覆盖 |
| Chromium narrow，阅读布局/独立阅读/移动 detail/横向溢出 | `2 passed, 3 skipped` |
| WebKit desktop，登录、文件夹导航、搜索、打开邮件、返回 | `1 passed` |

完整移动端 suite 的一次早期尝试曾在第 22 个 Telegram 用例附近遇到 Wrangler 4.113/Miniflare 的 `Network connection lost`；全新隔离状态下复跑已得到上表的历史结果。WebKit 全量 smoke 的一次启动遇到本地认证 binding `503`，随后主流程在全新状态下通过；因此这里把 WebKit 记录为目标流程证据，不把它表述为完整 WebKit suite 通过。

## 本轮实现验证（2026-09-17）

验证环境为本地 SvelteKit/Cloudflare Worker 预览、隔离 D1/R2 状态和合成邮件 fixture。当前环境没有 Browser plugin，因此使用仓库同一 Playwright 配置的 Chromium fallback；截图和临时浏览器状态在 `/tmp`，不属于发布产物。

覆盖尺寸：320、390、480、768、900、901、1023、1024、1280、1366 px；另测短视口、移动横屏、中文/英文、浅色/深色、标准/紧凑密度、侧栏展开/折叠、列表宽度和长主题/长正文。布局断言同时检查 body 起点、固定详情头、详情滚动拥有者、祖先裁剪交集后的实际可见正文高度、横向溢出、focus 和菜单边界；1366×768 目标为正文起点不超过 220 px、实际可见正文至少为视口 60%。

| 浏览器/范围 | 本轮结果 |
| --- | --- |
| Chromium desktop，完整 workspace suite | `25 passed, 4 skipped` |
| Chromium mobile，完整 workspace suite | `19 passed, 10 skipped` |
| Chromium narrow，完整 workspace suite | `15 passed, 14 skipped` |
| Chromium a11y，完整无障碍 suite | mobile `2 passed, 1 skipped`；narrow `1 passed, 2 skipped` |
| WebKit smoke，desktop/iPhone/iPad | 未执行：三个项目均因缺少 `/tmp/flaremail-browsers/webkit-2248/pw_run.sh` 在浏览器启动阶段退出；代码构建均完成 |

可复核命令：

```sh
bun run check
bun test
bun run build
bun run test:e2e
bun run test:a11y
bun run test:e2e:webkit
```

本轮 WebKit 命令确实启动了 desktop、iPhone 和 iPad 三个本地 Worker 预览，但 Playwright 的 WebKit executable 未安装，因此不能把该套件计为通过；Chromium 是本轮可用的浏览器 fallback。

详情正文可见高度的计算规则：对正文 `getBoundingClientRect()` 与 viewport、`.fm-detail-scroll`、详情面板及各祖先的可视矩形求交集；报告 `bodyTop`、固定头高度、`visibleBodyHeight` 和 `scrollOwner`，不使用 `scrollHeight`、iframe `height` 属性或 CSS 声明值代替实际可见空间。

## 当前跨浏览器复核（2026-09-28）

在隔离的本地 Worker、D1/R2 和合成邮件 fixture 上重新运行。Firefox 与 WebKit 浏览器二进制放在 `/tmp`；Firefox 因当前容器不允许创建用户命名空间，测试进程使用 `MOZ_DISABLE_CONTENT_SANDBOX=1` 和可写的临时 XDG 目录。WebKit 底部“HTML 写信选项”在 Playwright 指针点击时等待位置稳定超时，改用按钮原生的聚焦加 Enter 激活后，发送成功与明确失败反馈均通过；这不是指针路径已获全面验证的证据。iPad 的移动抽屉项目也曾等待指针稳定超时，辅助函数在先检查可见后强制点击，随后继续验证抽屉关闭和目标 URL。搜索用例等待带查询参数的邮箱响应完成与高亮出现，避免和异步筛选刷新竞态。

| 浏览器/范围 | 当前结果 |
| --- | --- |
| Firefox desktop，收件、标签、第二发件身份、域名尺寸矩阵与长内容/约 7 MB 附件 | 独立 smoke `7 passed` |
| WebKit desktop，登录/搜索/阅读、安全 HTML/CID/远程图片、写信/草稿/发送、主题与焦点 | 连续 smoke `7 passed` |
| WebKit iPhone / iPad，同一七项与移动视口、焦点、抽屉和触摸语义 | 各自连续 smoke `7 passed` |
| Chromium，当前桌面密度、图标提示、移动标签及无障碍回归 | 对应目标用例通过；未在这次复跑完整 Chromium suite |

截图 `/tmp/flaremail-list-default-desktop.png`（1505×1045）已与 `docs/design-concepts/flaremail-desktop-workspace.png` 同尺寸比对：三栏、选中态和品牌色接近；顶栏与列表行仍更紧凑，合成邮件内容和导航项也与概念稿不同。Linux WebKit 不等同于真实 macOS Safari；真实 Safari、屏幕阅读器和生产服务不属于本节证据。

## 证据边界

- D1、R2、邮件、Telegram API 和登录账号均为本地合成 fixture；没有执行远程 migration、部署、真实邮件发送、真实 Telegram 请求或 push。
- 浏览器截图、trace、日志和临时 Playwright 浏览器缓存位于 `/tmp`，不属于发布产物。
- 本地浏览器结果不等于 Browser plugin、CI/release、生产 Worker、真实邮件或真实 Telegram 客户端证据；这些边界仍需分别授权和验证。
- 本文档验证的是当前源码和本地 Worker 预览；生产域名、Workers Builds、真实绑定和 live `/api/health` 需要单独的授权后验证。
