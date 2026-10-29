# FlareMail

[English](./README.md) | 简体中文

<p align="center">
  <img src="./static/brand/flaremail-logo.svg" alt="FlareMail 标志" width="286" />
</p>

部署在 Cloudflare Workers 上的个人自托管邮件工作区。在一个响应式邮箱中管理多个域名和邮件地址，支持英文与简体中文界面。

## 功能

- **邮件收发**：通过 Cloudflare Email Routing 收件、Resend 发件，支持附件和投递状态跟踪。
- **邮件身份管理**：同步已有 Cloudflare 路由配置，管理域名和邮箱地址，选择发件身份与签名。
- **邮件整理**：收件分类、标签、星标、归档、垃圾箱、高级搜索和批量操作。
- **随处阅读与写信**：适配桌面和手机，支持分栏预览、专注阅读、回复、转发和草稿自动保存。菜单数字只提示待关注事项：未读收件、草稿，以及发送中或异常邮件。
- **访问与数据管理**：支持本地用户名/密码或 Cloudflare Access 认证，D1 保存结构化数据，R2 保存邮件原文与附件。
- **消息通知**：可选 Telegram 通知，支持隐私设置与投递重试。

## 开始使用

Cloudflare 操作统一使用全局 `cf`（Node.js ≥ 22.18），可用 `bun add --global cf` 安装。项目已弃用直接 Wrangler 命令；构建及配置迁移见[部署指南](./DEPLOY.md)。

自托管请按[部署指南](./DEPLOY.md)操作。需要 Cloudflare 账号、已配置 Email Routing 的域名，以及用于发件的 Resend。

本地开发请参阅[开发指南](./docs/DEVELOPMENT.md)。默认使用本机最新已安装的 Bun 稳定版（最低 **1.4.0**）。测试和部署在本机执行；GitHub 仅在发布 Release 或手动触发时扫描依赖安全，使用 `package.json` 记录的 Bun 版本。项目提供本地演示邮件服务。

邮件地址是由同一工作区 Owner 管理的收发资源；登录凭据和资料邮箱单独配置。

所有改动使用独立 worktree 和新分支。每次推送任务提交和每次创建 PR 前分别
执行本地 `/review`，解决所有有效问题后再继续；功能改动还需先完成远程 PRE
验收。所有 PR 合并前等待当前提交的 Codex Code Review 和 Security Review
完成并处理反馈，随后 rebase 合并到 `main`，核对并同步主分支，再清理本任务
已合并的 worktree 和本地/远端分支。这些 Git 步骤默认连续完成，用户明确
限制时遵从；Preview 和生产部署仍需单独授权。详见
[开发流程](./docs/DEVELOPMENT.md#worktree-and-pr-workflow)。

## 文档

| 指南 | 内容 |
| --- | --- |
| [使用指南](./docs/USER_GUIDE.md) | 日常邮件操作、邮件身份、搜索与设置 |
| [本地开发](./docs/DEVELOPMENT.md) | 环境准备、管理员初始化与验证 |
| [部署指南](./DEPLOY.md) | 首次部署、升级与回滚 |
| [维护与恢复](./docs/DEPLOYMENT.md) | 备份、搜索索引、清理与故障恢复 |
| [收信可靠性](./docs/specs/inbound-delivery-reliability.md) | 收信锁冲突、子地址、路由范围与验证边界 |
| [Telegram](./docs/TELEGRAM.md) | Bot 配置与通知运维 |
| [全部文档](./docs/README.md) | API、架构、预览、设计与发布记录 |

详细指南目前包含英文和中文，语言标注见[文档索引](./docs/README.md)。

## 许可证

FlareMail 采用 [GNU Affero General Public License](./LICENSE) 第 3 版，
或（由你选择）任何更高版本（`AGPL-3.0-or-later`）。

## HTML 邮件阅读

安全 HTML 阅读器在隔离的浅色画布中保留常用字体、配色、表格布局和按宽度响应的样式。
远程图片仍需手动授权，CSS 资源请求始终阻止，写信清洗策略保持不变。
详见 [HTML 安全边界](docs/API.md#html-safety-boundary)。

实现参考 [Roundcube](https://github.com/roundcube/roundcubemail/blob/master/program/lib/Roundcube/rcube_washtml.php)
和 [SnappyMail](https://github.com/the-djmaze/snappymail/blob/master/dev/Common/Html.js) 对排版与 CSS 清洗的处理，
使用 [CSSTree](https://github.com/csstree/csstree) 解析及验证 CSS，
并用 [parse5](https://github.com/inikulin/parse5) 规范化 HTML5 结构，避免畸形表格逃出正文容器。
