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
- **随处阅读与写信**：适配桌面和手机，支持分栏预览、专注阅读、回复、转发和草稿自动保存。
- **访问与数据管理**：支持本地用户名/密码或 Cloudflare Access 认证，D1 保存结构化数据，R2 保存邮件原文与附件。
- **消息通知**：可选 Telegram 通知，支持隐私设置与投递重试。

## 开始使用

自托管请按[部署指南](./DEPLOY.md)操作。需要 Cloudflare 账号、已配置 Email Routing 的域名，以及用于发件的 Resend。

本地开发请参阅[开发指南](./docs/DEVELOPMENT.md)。默认使用本机最新已安装的 Bun 稳定版（最低 **1.4.0**）。测试和部署在本机执行；GitHub 仅在发布 Release 或手动触发时扫描依赖安全，使用 `package.json` 记录的 Bun 版本。项目提供本地演示邮件服务。

邮件地址是由同一工作区 Owner 管理的收发资源；登录凭据和资料邮箱单独配置。

## 文档

| 指南 | 内容 |
| --- | --- |
| [使用指南](./docs/USER_GUIDE.md) | 日常邮件操作、邮件身份、搜索与设置 |
| [本地开发](./docs/DEVELOPMENT.md) | 环境准备、管理员初始化与验证 |
| [部署指南](./DEPLOY.md) | 首次部署、升级与回滚 |
| [维护与恢复](./docs/DEPLOYMENT.md) | 备份、搜索索引、清理与故障恢复 |
| [Telegram](./docs/TELEGRAM.md) | Bot 配置与通知运维 |
| [全部文档](./docs/README.md) | API、架构、预览、设计与发布记录 |

详细指南目前包含英文和中文，语言标注见[文档索引](./docs/README.md)。

## 许可证

[GNU General Public License v3.0](./LICENSE)。
