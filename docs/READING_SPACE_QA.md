# Reading-space QA

本文档记录 FlareMail 阅读工作台的尺寸契约、交互验收和证据边界。这里的浏览器数据来自隔离的本地 D1/R2 fixture；它证明本地构建和浏览器交互行为，不代表生产部署、真实邮件投递或真实 Telegram 调用。

## 行为契约

| 区域 | 约束 |
| --- | --- |
| 主侧栏 | 展开宽度 232px，折叠宽度 64px；折叠状态写入 `flaremail-layout-v1`，刷新后恢复。 |
| 邮件列表 | 用户偏好宽度 280–480px，默认 360px；拖拽和 `ArrowLeft`/`ArrowRight`/`Home`/`End` 可调整，`Enter` 恢复默认值。 |
| 详情区 | 分隔条 8px，详情区保留至少 360px；可用空间不足时只临时压缩列表的有效宽度，持久化的用户偏好不被覆盖。 |
| HTML 正文 | iframe 高度为 `clamp(22rem, 68dvh, 56rem)`；普通正文行宽约 78ch，专注阅读行宽约 86ch。 |
| 滚动 | 工作台详情由外层详情区域承载滚动，正文容器不再使用固定 `62vh`/`28rem` 高度制造嵌套滚动。 |
| 专注阅读 | 全局 dialog 接管焦点，背景不可操作；详情标题和关闭按钮各保留一个可见实例，`Escape` 关闭并恢复触发控件焦点。 |
| 独立阅读 | `/messages/[id]` 只返回当前 session 可见的元数据；正文、附件和安全 HTML 继续通过现有 owner-scoped API 读取，HTML 响应使用 `private, no-store`。 |
| 响应式 | 桌面使用列表/详情分栏；900px 及以下进入单面板 drill-in；320px 和 200% 模拟缩放不应产生横向溢出。 |
| 语言 | UI 支持 zh-CN、en 和“跟随浏览器”；选择写入 cookie/localStorage，SSR 初始语言与浏览器 `Accept-Language` 保持一致。数量文本使用 locale plural rules。 |
| 窗口同步 | BroadcastChannel 优先、localStorage 事件回退；只传播邮件状态信号、消息 ID 和会话结束事件，不传播正文、地址或凭据。 |

## 本地运行时测量

在 Chromium desktop（1280×900）打开安全 HTML fixture 后，浏览器测量为：

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

## 验证记录

固定 Bun 1.4.0 的门禁命令：

```sh
PATH=/tmp/flaremail-pinned-bin:/usr/bin:/bin /tmp/flaremail-pinned-bin/bun run check
PATH=/tmp/flaremail-pinned-bin:/usr/bin:/bin /tmp/flaremail-pinned-bin/bun test
PATH=/tmp/flaremail-pinned-bin:/usr/bin:/bin /tmp/flaremail-pinned-bin/bun run build
```

浏览器验证使用隔离端口和状态目录。仓库的 `bun run test:e2e` 在本机会触发 Playwright 子进程的 `playwright.config.ts.esm.preflight` 解析问题，因此本次使用同一 Playwright 配置由 Node CLI 直接启动：

| 浏览器/范围 | 结果 |
| --- | --- |
| Chromium desktop，完整 workspace suite | `24 passed, 4 skipped` |
| Chromium mobile，完整 workspace suite | `19 passed, 9 skipped`；此前暴露的登录输入同步竞态和 Telegram 主流程均在此结果中覆盖 |
| Chromium narrow，阅读布局/独立阅读/移动 detail/横向溢出 | `2 passed, 3 skipped` |
| WebKit desktop，登录、文件夹导航、搜索、打开邮件、返回 | `1 passed` |

完整移动端 suite 的一次早期尝试曾在第 22 个 Telegram 用例附近遇到 Wrangler 4.113/Miniflare 的 `Network connection lost`；全新隔离状态下复跑已得到上表的完整结果。WebKit 全量 smoke 的一次启动遇到本地认证 binding `503`，随后主流程在全新状态下通过；因此这里把 WebKit 记录为目标流程证据，不把它表述为完整 WebKit suite 通过。

## 证据边界

- D1、R2、邮件、Telegram API 和登录账号均为本地合成 fixture；没有执行远程 migration、部署、真实邮件发送、真实 Telegram 请求或 push。
- 浏览器截图、trace、日志和临时 Playwright 浏览器缓存位于 `/tmp`，不属于发布产物。
- 本文档验证的是当前源码和本地 Worker 预览；生产域名、Workers Builds、真实绑定和 live `/api/health` 需要单独的授权后验证。
