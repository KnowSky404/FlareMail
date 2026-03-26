# FlareMail

FlareMail 是一个运行在 **Cloudflare Workers** 上的单体邮件工作台。  
它把 **SvelteKit Web UI**、API、Cloudflare Email Routing 入站处理、D1/R2 持久化放在同一个 Worker 里。

当前仓库重点不是“从零脚手架”，而是一版已经跑通核心邮件链路的原型系统，适合继续做两类工作：

- UI / UX 打磨
- 邮件业务能力继续增强

## 当前状态

截至当前版本，下面这些能力已经验证通过：

- 真实入站邮件可写入 Worker
- 入站邮件会落到 D1 与 R2
- Web UI 能展示真实收件箱邮件
- 邮件详情正文加载正常
- 原始 `.eml` 下载正常
- 已读 / 星标 / 删除状态可持久化
- 草稿保存与已发送记录可持久化
- 写信弹窗已支持自动保存草稿与关闭前兜底保存
- Cloudflare Worker 原生自动回信正常
- Cloudflare Worker 原生通知邮件正常

## 当前边界

这几个点很重要，后续改 UI 或业务时不要混淆：

- **真实链路**
  - 入站收件：真实
  - 自动回信：真实
  - 通知邮件：真实
  - D1 / R2 持久化：真实
- **工作台主动发信**
  - 当前默认仍走 `demo` provider
  - 主要用于验证“写信 / 草稿 / 已发送 / 出站状态 UI”
  - 还不等于“任意外部地址真实外发”
- **登录**
  - 当前还是固定测试账号
  - 还没有接正式用户鉴权体系

## 架构概览

- `worker/index.ts`
  - Worker 统一入口
  - `fetch()` 交给 SvelteKit
  - `email()` 处理 Cloudflare Email Routing 入站邮件
- `src/routes/`
  - 页面与 API 路由
- `src/lib/server/`
  - Cloudflare、D1、R2、邮件处理、工作台状态逻辑
- `src/lib/components/mail/`
  - 当前邮件工作台 UI 组件
- `schema.sql`
  - D1 表结构定义

## 核心数据模型

当前主要使用这些表：

- `email_messages`
  - 真实入站邮件元数据
- `workspace_users`
  - 工作台用户资料
- `workspace_sessions`
  - 登录会话
- `workspace_messages`
  - 工作台内的已发送消息
- `workspace_drafts`
  - 草稿
- `workspace_email_states`
  - 用户对真实入站邮件的读写状态
- `workspace_outbound_statuses`
  - 出站状态
- `workspace_outbound_receipts`
  - 出站回执
- `workspace_outbound_events`
  - 出站事件时间线

## 关键交互

- 登录后通过 Cookie 恢复工作台状态
- 收件箱支持线程聚合
- 详情面板支持查看线程内消息
- 支持回复 / 转发 / 草稿编辑 / 草稿发送
- 写信弹窗支持自动保存状态提示
- 真实入站邮件支持正文解析与 `.eml` 下载
- 已发送支持队列 / 失败 / 重试状态展示

## 对 UI 改版最重要的事实

如果要让 Gemini 或其他设计工具改 UI，请默认以下约束成立：

- 不要改 API 路径
- 不要改组件事件语义
- 不要删除已存在业务按钮
- 不要破坏：
  - 登录
  - 收件箱
  - 线程查看
  - 邮件详情
  - 草稿
  - 已发送
  - 个人信息
  - 写信弹窗

专门给 UI 改版使用的提示文件在：

- [GEMINI_UI_PROMPT.md](./GEMINI_UI_PROMPT.md)

## 常用命令

```bash
bun install
bun run dev
bun run check
bun run build
bun run preview
bun run db:migrate:local
bun run deploy:dry-run
bun run deploy
```

## 相关文档

- [DEPLOY.md](./DEPLOY.md)：部署流程与线上配置说明
- [TODO.md](./TODO.md)：后续功能路线
- [GEMINI_UI_PROMPT.md](./GEMINI_UI_PROMPT.md)：UI 改版交接说明
